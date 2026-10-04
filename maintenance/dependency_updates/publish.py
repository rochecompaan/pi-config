"""Publish an already validated tree with an exact branch lease."""

import contextlib
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

from .candidate import assert_tree, git
from .forgejo_api import ForgejoClient
from .model import Candidate, UpdateError, PIN_FILE, load_catalog, read_json_file, valid_id


def bot_branch(unit_id: str) -> str:
    return "automation/dependencies/" + valid_id(unit_id)


@contextlib.contextmanager
def _authentication(client: ForgejoClient, login: str):
    with tempfile.TemporaryDirectory(prefix="dependency-git-auth-") as directory:
        helper = Path(directory) / "askpass"
        helper.write_text('#!/bin/sh\ncase "$1" in\n*Username*) printf "%s\\n" "$DEPENDENCY_UPDATE_GIT_USER";;\n'
                          '*Password*) printf "%s\\n" "$DEPENDENCY_UPDATE_GIT_TOKEN";;\n*) exit 1;;\nesac\n')
        helper.chmod(0o700)
        yield {**os.environ, "GIT_ASKPASS": str(helper), "GIT_TERMINAL_PROMPT": "0",
               "DEPENDENCY_UPDATE_GIT_USER": login, "DEPENDENCY_UPDATE_GIT_TOKEN": client.token,
               "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "credential.helper", "GIT_CONFIG_VALUE_0": ""}


def _network_git(root: Path, args: list[str], run, environment: dict) -> str:
    try:
        result = run(["git", *args], cwd=root, env=environment, text=True,
                     capture_output=True, check=False, timeout=120)
    except (OSError, subprocess.SubprocessError):
        raise UpdateError("publication", "Git network operation could not complete") from None
    if result.returncode:
        raise UpdateError("publication", f"Git {args[0]} failed (exit {result.returncode}); publication stopped")
    return result.stdout.strip()


def _guard(root: Path, candidate: Candidate):
    if not candidate.validated:
        raise UpdateError("publication", "Candidate has not passed validation")
    units, _ = load_catalog(root)
    unit = units.get(candidate.unit_id)
    if unit is None or not candidate.paths or set(candidate.paths) - set(unit.paths):
        raise UpdateError("publication", "Candidate paths are not owned by the declared unit")
    assert_tree(root, candidate, "publication")
    try:
        before = json.loads(git(root, "show", f"{candidate.base_sha}:{PIN_FILE}", stage="publication"))
        after = read_json_file(root / PIN_FILE)
        if set(before) != set(after) or any(after[key] != value for key, value in before.items() if key not in unit.source_ids):
            raise ValueError()
    except (TypeError, ValueError, KeyError):
        raise UpdateError("publication", "Candidate includes unowned source changes") from None
    return unit


def _matching_pull(client: ForgejoClient, branch: str, base: str, actor: dict) -> dict | None:
    matches = []
    for pull in client.open_pulls():
        head = pull.get("head")
        if not isinstance(head, dict):
            raise UpdateError("publication", "Pull head response is malformed")
        if head.get("ref") != branch:
            continue
        try:
            if head["repo"]["full_name"] != client.repository or pull["base"]["repo"]["full_name"] != client.repository or pull["base"]["ref"] != base:
                raise ValueError()
            if pull["user"]["id"] != actor["id"] or pull["user"]["login"] != actor["login"]:
                raise ValueError()
            client._pull(pull)
        except (KeyError, TypeError, ValueError):
            raise UpdateError("publication", "Existing pull belongs to another author, base, or repository") from None
        matches.append(pull)
    if len(matches) > 1:
        raise UpdateError("publication", "Multiple open pulls claim the bot branch")
    return matches[0] if matches else None


def _remote_heads(root: Path, remote: str, candidate: Candidate, branch: str, run, environment: dict) -> str:
    base_ref, bot_ref = "refs/heads/" + candidate.base_branch, "refs/heads/" + branch
    output = _network_git(root, ["ls-remote", "--symref", remote, "HEAD", base_ref, bot_ref], run, environment)
    refs, default = {}, None
    for line in output.splitlines():
        value, separator, ref = line.partition("\t")
        if not separator:
            raise UpdateError("publication", "Remote Git reference response is malformed")
        if value.startswith("ref: ") and ref == "HEAD":
            default = value.removeprefix("ref: ")
        elif re.fullmatch(r"[0-9a-f]{40}(?:[0-9a-f]{24})?", value):
            if ref in refs:
                raise UpdateError("publication", "Remote reference is ambiguous")
            refs[ref] = value
        else:
            raise UpdateError("publication", "Remote Git reference response is malformed")
    if default != base_ref or refs.get(base_ref) != candidate.base_sha:
        raise UpdateError("publication", "Default branch moved; prepare and validate against the new base")
    return refs.get(bot_ref, "")


def _owned_commit(root: Path, sha: str, unit_id: str, login: str) -> tuple[str, str]:
    author = git(root, "show", "-s", "--format=%an%n%cn", sha, stage="publication").splitlines()
    parent = git(root, "show", "-s", "--format=%P", sha, stage="publication")
    trailers = git(root, "show", "-s", "--format=%(trailers:only,unfold)", sha, stage="publication").splitlines()
    unit = [line.removeprefix("Dependency-Update-Unit: ") for line in trailers if line.startswith("Dependency-Update-Unit: ")]
    base = [line.removeprefix("Dependency-Update-Base: ") for line in trailers if line.startswith("Dependency-Update-Base: ")]
    if author != [login, login] or unit != [unit_id] or len(base) != 1 or parent != base[0]:
        raise UpdateError("publication", "Existing branch lacks valid bot ownership metadata")
    return git(root, "show", "-s", "--format=%T", sha, stage="publication"), parent


def publish(root: Path, candidate: Candidate, client: ForgejoClient, run=subprocess.run) -> str | None:
    if not candidate.changed:
        return None
    _guard(root, candidate)
    branch = bot_branch(candidate.unit_id)
    git(root, "check-ref-format", "--branch", candidate.base_branch, stage="publication")
    if branch == candidate.base_branch:
        raise UpdateError("publication", "Bot branch cannot be the default branch")
    remote = git(root, "config", "--get", "remote.origin.url", stage="publication")
    client.check_git_remote(remote)
    actor = client.current_user()
    pull = _matching_pull(client, branch, candidate.base_branch, actor)
    title = f"chore(deps): update {candidate.unit_id}"
    body = (f"Nightly dependency update: `{candidate.unit_id}`\n\n{candidate.summary}\n\n"
            f"Base: `{candidate.base_sha}`\nValidated tree: `{candidate.tree_sha}`\n\n"
            "Package builds, extension loading, and full flake checks passed with Nix sandboxing disabled.\n"
            "Merge manually after review; this workflow never merges pull requests.")
    with _authentication(client, actor["login"]) as environment:
        previous = _remote_heads(root, remote, candidate, branch, run, environment)
        same = False
        commit = previous
        if previous:
            _network_git(root, ["fetch", "--no-tags", remote, previous], run, environment)
            tree, parent = _owned_commit(root, previous, candidate.unit_id, actor["login"])
            same = tree == candidate.tree_sha and parent == candidate.base_sha
        if not same:
            assert_tree(root, candidate, "publication")
            message = (f"{title}\n\n{candidate.summary}\n\nDependency-Update-Unit: {candidate.unit_id}\n"
                       f"Dependency-Update-Base: {candidate.base_sha}\n")
            identity = {**environment, "GIT_AUTHOR_NAME": actor["login"], "GIT_COMMITTER_NAME": actor["login"],
                        "GIT_AUTHOR_EMAIL": "dependency-updater@localhost", "GIT_COMMITTER_EMAIL": "dependency-updater@localhost"}
            commit = git(root, "-c", "commit.gpgsign=false", "commit-tree", candidate.tree_sha, "-p", candidate.base_sha,
                         stage="publication", input=message, env=identity)
            ref = "refs/heads/" + branch
            _network_git(root, ["push", f"--force-with-lease={ref}:{previous}", remote, f"{commit}:{ref}"], run, environment)
        # Reuse bypasses the push lease; both paths must still match before PR edits.
        if _remote_heads(root, remote, candidate, branch, run, environment) != commit:
            raise UpdateError("publication", "Bot branch moved; publication stopped without editing the pull")
        # API failure after a successful push leaves an owned, reusable orphan.
        if pull is None:
            pull = client.create_pull(branch, candidate.base_branch, title, body)
        elif pull.get("title") != title or pull.get("body") != body:
            pull = client.update_pull(pull["number"], title, body)
        return pull["html_url"]
