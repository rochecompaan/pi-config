"""Lockfile policies and npm cache hashes, without upstream lifecycle scripts."""

import copy
import json
import os
import subprocess
import tarfile
import tempfile
from pathlib import Path

from .model import UpdateError, check_hash, valid_path
from .npm_integrity import repair_lock_integrity
from .sources import read_upstream_json

MAX_JSON = 20 * 1024 * 1024
DEPENDENCY_FIELDS = ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta")


def _source_bytes(fetched: Path, fetcher: str, filename: str) -> bytes:
    try:
        if fetcher == "fetchurl":
            with tarfile.open(fetched, "r:*") as archive:
                entries = [entry for entry in archive if entry.name == "package/" + filename]
                if len(entries) != 1 or not entries[0].isfile() or entries[0].size > MAX_JSON:
                    raise ValueError("Missing, duplicate, oversized, or linked archive member")
                stream = archive.extractfile(entries[0])
                if stream is None:
                    raise ValueError("Missing archive member data")
                result = stream.read(MAX_JSON + 1)
        else:
            path = fetched / filename
            if path.is_symlink() or not path.resolve().is_relative_to(fetched.resolve()):
                raise ValueError("Linked source metadata")
            with path.open("rb") as stream:
                result = stream.read(MAX_JSON + 1)
        if len(result) > MAX_JSON:
            raise ValueError("Source JSON too large")
        return result
    except (OSError, ValueError, tarfile.TarError) as error:
        raise UpdateError("lockfile", f"Cannot read regular source metadata: {filename}") from error


def _json_object(content: bytes) -> dict:
    try:
        data = json.loads(content)
        if not isinstance(data, dict):
            raise ValueError()
        return data
    except (TypeError, ValueError) as error:
        raise UpdateError("lockfile", "Source metadata must be a JSON object") from error


def source_manifest(fetched: Path, fetcher: str) -> dict:
    return _json_object(_source_bytes(fetched, fetcher, "package.json"))


def effective_manifest(source_id: str, manifest: dict) -> dict:
    result = copy.deepcopy(manifest)
    if not isinstance(result, dict) or any(not isinstance(result.get(field), str) or not result[field] for field in ("name", "version")):
        raise UpdateError("lockfile", "Package manifest requires name and version")
    for field in DEPENDENCY_FIELDS:
        if field in result and not isinstance(result[field], dict):
            raise UpdateError("lockfile", f"Invalid manifest declaration: {field}")
    if source_id == "pi-remote":
        result.pop("devDependencies", None)
        result["scripts"] = {}
    return result


def _validate_lock(content: bytes, manifest: dict) -> dict:
    lock = _json_object(content)
    try:
        package = lock["packages"][""]
        if lock["lockfileVersion"] not in {2, 3} or not isinstance(package, dict):
            raise ValueError()
        if any(package.get(field) != manifest[field] for field in ("name", "version")):
            raise ValueError()
        if any(package.get(field, {}) != manifest.get(field, {}) for field in DEPENDENCY_FIELDS):
            raise ValueError()
    except (KeyError, TypeError, ValueError) as error:
        raise UpdateError("lockfile", "Lock root differs from effective package declarations") from error
    return lock


def _repair_root_version(content: bytes, manifest: dict) -> bytes:
    lock = _json_object(content)
    root = lock.get("packages", {}).get("") if isinstance(lock.get("packages"), dict) else None
    version = root.get("version") if isinstance(root, dict) else None
    if not isinstance(version, str) or not version:
        raise UpdateError("lockfile", "Lock root requires a version")
    # Release commits sometimes bump package.json without npm updating the
    # lock's labels. Check every dependency declaration before fixing labels;
    # never re-resolve the upstream graph or hide a different package name.
    _validate_lock(content, {**manifest, "version": version})
    if root["version"] == manifest["version"] and lock.get("version", manifest["version"]) == manifest["version"]:
        return content
    root["version"] = manifest["version"]
    if "version" in lock:
        lock["version"] = manifest["version"]
    return (json.dumps(lock, indent=2) + "\n").encode()


def _execute(command: list[str], work: Path, run, stage: str) -> str:
    environment = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "NPM_CONFIG_IGNORE_SCRIPTS": "true",
                   "NPM_CONFIG_USERCONFIG": str(work / "empty-npmrc"),
                   "NPM_CONFIG_CACHE": str(work / "npm-cache")}
    environment.pop("DEPENDENCY_UPDATE_TOKEN", None)
    try:
        result = run(command, cwd=work, capture_output=True, text=True, check=False,
                     timeout=600, env=environment)
    except (OSError, subprocess.SubprocessError) as error:
        raise UpdateError(stage, f"{command[0]} could not complete") from error
    if result.returncode:
        raise UpdateError(stage, f"{command[0]} failed (exit {result.returncode}): {result.stderr[-1000:]}")
    return result.stdout


def refresh_npm_lock(root: Path, source_id: str, fetched: Path, policy: dict, run=subprocess.run,
                     read_json=read_upstream_json) -> tuple[bytes, str]:
    manifest = effective_manifest(source_id, source_manifest(fetched, policy["fetcher"]))
    rule = policy["lock"]
    with tempfile.TemporaryDirectory(prefix="dependency-lock-") as directory:
        work = Path(directory)
        (work / "empty-npmrc").write_text("")
        (work / "package.json").write_text(json.dumps(manifest, indent=2) + "\n")
        lock_path = work / "package-lock.json"
        if rule["kind"] == "maintained":
            seed = root / valid_path(rule["path"])
            if seed.is_symlink():
                raise UpdateError("lockfile", "Maintained lock may not be a symlink")
            try:
                lock_path.write_bytes(seed.read_bytes())
            except OSError as error:
                raise UpdateError("lockfile", "Maintained seed lock is missing") from error
            _execute(["npm", "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund",
                      "--registry=https://registry.npmjs.org"], work, run, "lockfile")
        elif rule["kind"] in {"upstream", "patched-upstream", "repaired-upstream"}:
            content = _source_bytes(fetched, policy["fetcher"], "package-lock.json")
            if rule["kind"] == "repaired-upstream":
                content = _repair_root_version(content, manifest)
                content = repair_lock_integrity(content, read_json)
            lock_path.write_bytes(content)
            if rule["kind"] == "patched-upstream":
                patch = root / valid_path(rule["patch"])
                _execute(["patch", "--batch", "--forward", "--fuzz=0", "-p1", "--input", str(patch)], work, run, "lockfile")
        else:
            raise UpdateError("lockfile", "Unsupported npm lock policy")
        try:
            content = lock_path.read_bytes()
        except OSError as error:
            raise UpdateError("lockfile", "npm did not produce a lockfile") from error
        if len(content) > MAX_JSON:
            raise UpdateError("lockfile", "Lockfile exceeds size limit")
        _validate_lock(content, manifest)
        output = _execute(["prefetch-npm-deps", str(lock_path)], work, run, "npm-hash")
        return content, check_hash(output.strip(), "npm-hash")
