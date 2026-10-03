"""Inventory ownership and the data carried between update stages."""

import base64
import binascii
import copy
import json
import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

PIN_FILE = "nix/dependency-pins.json"
CATALOG_FILE = "maintenance/dependency_updates/catalog.json"
RECIPES = tuple(f"nix/packages/{name}.nix" for name in ("pi-deps", "pi-remote", "pi-intervals"))
FETCHERS = {"fetchzip": "fetchzip", "fetchurl": "fetchurl", "fetchgit": "fetchgit", "github-archive": "fetchFromGitHub"}
CHANNELS = {"npm-latest", "git-stable-tag", "git-default-head", "companion"}
PIN_FIELDS = {"version", "rev", "url", "hash", "sha256", "npmDepsHash"}


class UpdateError(Exception):
    def __init__(self, stage: str, message: str):
        self.stage = stage
        super().__init__(message)


@dataclass(frozen=True)
class Unit:
    id: str
    source_ids: tuple[str, ...]
    builds: tuple[str, ...]
    paths: tuple[str, ...]


@dataclass(frozen=True)
class Candidate:
    unit_id: str
    base_branch: str
    base_sha: str
    tree_sha: str
    paths: tuple[str, ...]
    summary: str
    changed: bool
    validated: bool = False


def valid_id(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[a-z][a-z0-9-]*", value):
        raise UpdateError("inventory", "Invalid dependency identifier")
    return value


def valid_path(value: str) -> str:
    if not isinstance(value, str) or not value or "\\" in value:
        raise UpdateError("inventory", "Invalid repository path")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"..", ".git"} for part in path.parts) or str(path) != value:
        raise UpdateError("inventory", "Repository path is not canonical")
    return value


def check_hash(value: str, stage: str = "inventory") -> str:
    try:
        if not isinstance(value, str) or not value.startswith("sha256-"):
            raise ValueError()
        digest = base64.b64decode(value[7:], validate=True)
        if len(digest) != 32 or digest == bytes(32):
            raise ValueError()
    except (ValueError, binascii.Error) as error:
        raise UpdateError(stage, "Invalid or placeholder SHA256 hash") from error
    return value


def read_json_file(path: Path) -> dict:
    try:
        data = json.loads(path.read_text())
        if not isinstance(data, dict):
            raise ValueError("Expected a JSON object")
        return data
    except (OSError, ValueError) as error:
        raise UpdateError("inventory", f"Cannot read JSON object: {path.name}") from error


def _strings(value, label: str) -> tuple[str, ...]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value) or len(set(value)) != len(value):
        raise UpdateError("inventory", f"Invalid {label} list")
    return tuple(value)


def _check_pin(fields: dict) -> None:
    if not isinstance(fields, dict) or not fields or set(fields) - PIN_FIELDS:
        raise UpdateError("inventory", "Unknown or missing pin fields")
    if any(not isinstance(value, str) or not value or any(ord(char) < 32 for char in value) for value in fields.values()):
        raise UpdateError("inventory", "Pin fields must be nonempty strings without control characters")
    if "hash" in fields and "sha256" in fields:
        raise UpdateError("inventory", "Source has two conflicting hash fields")
    for field in ("hash", "sha256", "npmDepsHash"):
        if field in fields:
            check_hash(fields[field])


def _check_policy(source_id: str, policy: dict, pins: dict) -> None:
    valid_id(source_id)
    if not isinstance(policy, dict) or policy.get("fetcher") not in FETCHERS or policy.get("channel") not in CHANNELS:
        raise UpdateError("inventory", f"Unsupported source policy: {source_id}")
    field = policy.get("hash_field")
    if field not in {"hash", "sha256"} or field not in pins:
        raise UpdateError("inventory", f"Missing source hash field: {source_id}")
    if policy["channel"].startswith("git-"):
        if not re.fullmatch(r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\.git", policy.get("repo", "")):
            raise UpdateError("inventory", f"Unsupported Git repository: {source_id}")
    if policy["channel"] == "npm-latest" and not re.fullmatch(r"(?:@[a-z0-9._-]+/)?[a-z0-9._-]+", policy.get("package", "")):
        raise UpdateError("inventory", f"Invalid npm package: {source_id}")
    if policy["channel"] == "companion" and policy.get("rule") not in {"manifest-range", "same-version", "lock-version"}:
        raise UpdateError("inventory", f"Unsupported companion rule: {source_id}")
    lock = policy.get("lock")
    if lock is not None:
        if not isinstance(lock, dict) or lock.get("kind") not in {"maintained", "upstream", "patched-upstream"}:
            raise UpdateError("inventory", f"Unsupported lock policy: {source_id}")
        for key in ("path", "patch"):
            if key in lock:
                valid_path(lock[key])


def load_catalog(root: Path) -> tuple[dict[str, Unit], dict[str, dict]]:
    catalog = read_json_file(root / CATALOG_FILE)
    pins = read_json_file(root / PIN_FILE)
    policies, entries = catalog.get("sources"), catalog.get("units")
    if not isinstance(policies, dict) or not isinstance(entries, dict) or not entries:
        raise UpdateError("inventory", "Catalog requires sources and units")
    if set(pins) != set(policies):
        raise UpdateError("inventory", "Catalog and pin source sets differ")
    for source_id, fields in pins.items():
        _check_pin(fields)
        _check_policy(source_id, policies[source_id], fields)
    units, owned = {}, set()
    for unit_id, entry in entries.items():
        valid_id(unit_id)
        if not isinstance(entry, dict):
            raise UpdateError("inventory", "Invalid unit entry")
        sources = _strings(entry.get("sources"), "source")
        builds = _strings(entry.get("builds"), "build")
        paths = _strings(entry.get("paths"), "path")
        for name in builds:
            valid_id(name)
        for path in paths:
            valid_path(path)
            if path not in {PIN_FILE, "flake.lock"} and not path.endswith("-package-lock.json"):
                raise UpdateError("inventory", "Unit owns a non-dependency path")
        if unit_id == "flake-inputs":
            if sources or paths != ("flake.lock",):
                raise UpdateError("inventory", "Flake unit may only own flake.lock")
        elif not sources or PIN_FILE not in paths or "flake.lock" in paths:
            raise UpdateError("inventory", "Invalid package unit ownership")
        earlier = set()
        for source_id in sources:
            if source_id not in policies or source_id in owned:
                raise UpdateError("inventory", "Unknown or multiply owned source")
            policy = policies[source_id]
            if policy["channel"] == "companion" and policy.get("primary") not in earlier:
                raise UpdateError("inventory", "Companion must follow its primary in the same unit")
            lock = policy.get("lock", {})
            if lock.get("kind") == "maintained" and lock.get("path") not in paths:
                raise UpdateError("inventory", "Maintained lock is not owned by its unit")
            earlier.add(source_id)
            owned.add(source_id)
        units[unit_id] = Unit(unit_id, sources, builds, paths)
    if owned != set(policies):
        raise UpdateError("inventory", "A source has no owning update unit")
    return units, policies


def audit_sources(root: Path, policies: dict[str, dict]) -> None:
    calls, marked = [], []
    call = r"pkgs\.(fetchzip|fetchurl|fetchgit|fetchFromGitHub)\s*\{"
    marker = r"# dependency-source: ([a-z][a-z0-9-]*)\n\s*\w+\s*=\s*" + call
    for recipe in RECIPES:
        text = (root / recipe).read_text()
        calls.extend(re.findall(call, text))
        marked.extend(re.findall(marker, text))
    ids = [source_id for source_id, _ in marked]
    if len(calls) != len(marked) or len(ids) != len(set(ids)) or set(ids) != set(policies):
        raise UpdateError("inventory", "Unmarked, duplicate, or unmanaged Nix source fetcher")
    for source_id, fetcher in marked:
        if FETCHERS[policies[source_id]["fetcher"]] != fetcher:
            raise UpdateError("inventory", f"Fetcher differs from catalog: {source_id}")


def edit_pins(pins: dict, unit: Unit, replacements: dict) -> dict:
    allowed = set(unit.source_ids)
    if set(replacements) - allowed or allowed - set(pins):
        raise UpdateError("inventory", "Replacement includes an unowned or missing source")
    result = copy.deepcopy(pins)
    for source_id, fields in replacements.items():
        if not isinstance(fields, dict) or set(fields) - set(pins[source_id]):
            raise UpdateError("inventory", "Replacement includes a new pin field")
        result[source_id].update(fields)
        _check_pin(result[source_id])
    return result
