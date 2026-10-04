"""Unit-scoped preparation, immutable validation, and durable reports."""

import dataclasses
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

from .model import (Candidate, Unit, UpdateError, PIN_FILE, audit_sources, edit_pins,
                    load_catalog, read_json_file, valid_id, valid_path)
from .npm_lock import refresh_npm_lock, source_manifest
from .sources import prefetch_source, read_upstream_json, remote_refs, resolve_companion, resolve_source


def git(root: Path, *args: str, stage: str = "preparation", input: str | None = None, env=None) -> str:
    try:
        result = subprocess.run(["git", *args], cwd=root, input=input, env=env,
                                capture_output=True, text=True, check=False, timeout=60)
    except (OSError, subprocess.SubprocessError) as error:
        raise UpdateError(stage, "Git operation could not complete") from error
    if result.returncode:
        raise UpdateError(stage, f"Git {args[0]} failed (exit {result.returncode})")
    return result.stdout.strip()


def changed_paths(root: Path) -> tuple[str, ...]:
    return tuple(sorted(path for path in git(root, "diff", "--name-only", "--no-renames", "HEAD", "-z").split("\0") if path))


def assert_tree(root: Path, candidate: Candidate, stage: str = "validation") -> None:
    if git(root, "rev-parse", "HEAD", stage=stage) != candidate.base_sha or git(root, "write-tree", stage=stage) != candidate.tree_sha:
        raise UpdateError(stage, "Candidate base or index tree changed")
    git(root, "diff", "--quiet", stage=stage)
    if git(root, "ls-files", "--others", "--exclude-standard", "-z", stage=stage):
        raise UpdateError(stage, "Untracked files appeared after preparation")
    if changed_paths(root) != candidate.paths:
        raise UpdateError(stage, "Candidate changed paths no longer match its report")


def _run(command: list[str], root: Path, run, stage: str) -> str:
    try:
        environment = dict(os.environ)
        environment.pop("DEPENDENCY_UPDATE_TOKEN", None)
        result = run(command, cwd=root, capture_output=True, text=True, check=False,
                     timeout=3600, env=environment)
    except (OSError, subprocess.SubprocessError) as error:
        raise UpdateError(stage, f"{command[0]} could not complete") from error
    if result.returncode:
        raise UpdateError(stage, f"{command[0]} failed (exit {result.returncode}): {result.stderr[-2000:]}")
    return result.stdout


def _identity_changed(policy: dict, old: dict, selected: dict) -> bool:
    fields = ("rev",) if policy["channel"].startswith("git-") else ("version", "url")
    return any(selected.get(field) != old.get(field) for field in fields)


def _collect(root: Path, unit: Unit, policies: dict, pins: dict, run, read_json, ls_remote) -> tuple[dict, dict]:
    selected, cache = {}, {}
    upstream_changed = False
    for source_id in unit.source_ids:
        policy, old = policies[source_id], pins[source_id]
        if policy["channel"] == "companion":
            continue
        selected[source_id] = resolve_source(policy, old, read_json, ls_remote)
        changed = _identity_changed(policy, old, selected[source_id])
        if policy["channel"] == "git-stable-tag" and not changed:
            cache[source_id] = prefetch_source(root, policy, selected[source_id], run)
            changed = cache[source_id][0][policy["hash_field"]] != old[policy["hash_field"]]
        upstream_changed |= changed
    if not upstream_changed:
        return {}, {}
    replacements, files, manifests, locks = {}, {}, {}, {}
    for source_id in unit.source_ids:
        policy, old = policies[source_id], pins[source_id]
        if policy["channel"] == "companion":
            selected[source_id] = resolve_companion(policy, manifests, locks, read_json, run)
        fields, fetched = cache.get(source_id) or prefetch_source(root, policy, selected[source_id], run)
        manifest = None
        if "package" in policy:
            manifest = source_manifest(fetched, policy["fetcher"])
            if manifest.get("name") != policy["package"]:
                raise UpdateError("source-hash", "Fetched package name differs from selected upstream")
            if "version" in selected[source_id] and manifest.get("version") != selected[source_id]["version"]:
                raise UpdateError("source-hash", "Fetched package version differs from selected upstream")
            manifests[source_id] = manifest
        style = policy.get("version_style")
        if style:
            version = manifest.get("version") if manifest else None
            if not isinstance(version, str) or not version:
                raise UpdateError("source-hash", "Git package has no manifest version")
            if style == "short-rev":
                fields["version"] = version + "-" + fields["rev"][:7]
            elif style == "commit-date":
                fields["version"] = version + "-unstable-" + fields["commit_date"]
            else:
                raise UpdateError("inventory", "Unsupported Git version label policy")
        updates = {key: value for key, value in fields.items() if key in old}
        source_changed = any(old[key] != value for key, value in updates.items())
        if "lock" in policy and source_changed:
            content, digest = refresh_npm_lock(root, source_id, fetched, policy, run)
            updates["npmDepsHash"] = digest
            locks[source_id] = json.loads(content)
            if policy["lock"]["kind"] == "maintained":
                files[policy["lock"]["path"]] = content
        replacements[source_id] = updates
    return replacements, files


def prepare(root: Path, unit: Unit, base_branch: str, base_sha: str, run=subprocess.run,
            read_json=read_upstream_json, ls_remote=remote_refs) -> Candidate:
    valid_id(unit.id)
    units, policies = load_catalog(root)
    if units.get(unit.id) != unit:
        raise UpdateError("inventory", "Unit does not match the trusted catalog")
    audit_sources(root, policies)
    git(root, "check-ref-format", "--branch", base_branch)
    if not re.fullmatch(r"[0-9a-f]{40}(?:[0-9a-f]{24})?", base_sha) or git(root, "rev-parse", "HEAD") != base_sha:
        raise UpdateError("preparation", "Checkout is not at the selected base commit")
    if git(root, "status", "--porcelain", "--untracked-files=all"):
        raise UpdateError("preparation", "Preparation requires a clean checkout")
    pins = read_json_file(root / PIN_FILE)
    try:
        if unit.id == "flake-inputs":
            _run(["nix", "flake", "update"], root, run, "lookup")
        else:
            replacements, files = _collect(root, unit, policies, pins, run, read_json, ls_remote)
            updated = edit_pins(pins, unit, replacements)
            if set(files) - set(unit.paths):
                raise UpdateError("preparation", "Lock replacement is not owned by the unit")
            if updated != pins:
                (root / PIN_FILE).write_text(json.dumps(updated, indent=2, sort_keys=True) + "\n")
            for path, content in files.items():
                (root / valid_path(path)).write_bytes(content)
        paths = changed_paths(root)
        if set(paths) - set(unit.paths):
            raise UpdateError("preparation", "Update changed an unowned path")
        actual = read_json_file(root / PIN_FILE)
        if any(actual.get(key) != value for key, value in pins.items() if key not in unit.source_ids) or set(actual) != set(pins):
            raise UpdateError("preparation", "Update changed an unrelated source record")
        load_catalog(root)
        if paths:
            git(root, "add", "--", *paths)
        summary = "No upstream changes"
        if paths and unit.id == "flake-inputs":
            summary = "Update all flake inputs"
        elif paths:
            lines = []
            for key in unit.source_ids:
                if actual[key] != pins[key]:
                    old = pins[key].get("version", pins[key].get("rev", "source"))
                    new = actual[key].get("version", actual[key].get("rev", "source"))
                    lines.append(f"{key}: {old} -> {new}" + (" (hash update)" if old == new else ""))
            summary = "\n".join(lines)
        return Candidate(unit.id, base_branch, base_sha, git(root, "write-tree"), paths, summary, bool(paths))
    except Exception as error:
        git(root, "restore", "--source", base_sha, "--staged", "--worktree", "--", *unit.paths)
        if isinstance(error, UpdateError):
            raise
        raise UpdateError("preparation", "Candidate preparation failed") from error


def validate(root: Path, unit: Unit, candidate: Candidate, run=subprocess.run) -> Candidate:
    if candidate.unit_id != unit.id or set(candidate.paths) - set(unit.paths):
        raise UpdateError("validation", "Candidate does not belong to this unit")
    assert_tree(root, candidate)
    if not candidate.changed:
        return candidate
    builds = unit.builds
    if unit.id == "flake-inputs":
        try:
            names = json.loads(_run(["nix", "eval", "--json", ".#packages.x86_64-linux", "--apply", "builtins.attrNames"], root, run, "validation"))
            if not isinstance(names, list) or not names:
                raise ValueError()
            builds = tuple(valid_id(name) for name in names)
        except (TypeError, ValueError) as error:
            raise UpdateError("validation", "Cannot discover flake package build targets") from error
    flags = ["--option", "sandbox", "false", "--no-update-lock-file"]
    commands = [["nix", "build", f".#packages.x86_64-linux.{name}", "--no-link", *flags] for name in builds]
    commands += [["nix", "build", ".#checks.x86_64-linux.pi-config-extension-load", "--no-link", *flags],
                 ["nix", "flake", "check", "--accept-flake-config", "--print-build-logs", *flags]]
    for command in commands:
        _run(command, root, run, "validation")
    assert_tree(root, candidate)
    return dataclasses.replace(candidate, validated=True)


def write_report(path: Path, candidate: Candidate | None, error: UpdateError | None = None) -> None:
    envelope = {"schema": 1, "candidate": dataclasses.asdict(candidate) if candidate else None,
                "error": {"stage": error.stage, "message": str(error)} if error else None}
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, prefix=".candidate-", delete=False) as output:
        json.dump(envelope, output, indent=2)
        output.write("\n")
        temporary = Path(output.name)
    temporary.replace(path)


def read_report(path: Path) -> Candidate:
    envelope = read_json_file(path)
    try:
        data = envelope["candidate"]
        if type(envelope.get("schema")) is not int or envelope["schema"] != 1 or envelope.get("error") is not None or not isinstance(data, dict):
            raise ValueError()
        valid_id(data["unit_id"])
        if any(not isinstance(data[field], str) for field in ("base_branch", "base_sha", "tree_sha", "summary")):
            raise ValueError()
        if any(not re.fullmatch(r"[0-9a-f]{40}(?:[0-9a-f]{24})?", data[field]) for field in ("base_sha", "tree_sha")):
            raise ValueError()
        if type(data["changed"]) is not bool or type(data["validated"]) is not bool or not isinstance(data["paths"], list):
            raise ValueError()
        paths = tuple(valid_path(path) for path in data["paths"])
        if len(set(paths)) != len(paths) or bool(paths) != data["changed"] or data["validated"] and not data["changed"]:
            raise ValueError()
        return Candidate(**{**data, "paths": paths})
    except (KeyError, TypeError, ValueError) as error:
        raise UpdateError("inventory", "Invalid or failed candidate report") from error
