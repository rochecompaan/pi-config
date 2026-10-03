"""Stable upstream selection and fetcher-specific Nix source hashes."""

import datetime
import json
import os
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .model import UpdateError, check_hash

STABLE = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\+[0-9A-Za-z.-]+)?")
SHA = re.compile(r"[0-9a-f]{40}(?:[0-9a-f]{24})?")


def _stable(value) -> bool:
    return isinstance(value, str) and STABLE.fullmatch(value) is not None


def _version_key(value: str) -> tuple[int, int, int]:
    match = STABLE.fullmatch(value.removeprefix("v"))
    return tuple(int(part) for part in match.groups())


def _https(url: str, hosts: set[str]) -> str:
    if not isinstance(url, str):
        raise UpdateError("lookup", "Missing upstream URL")
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname not in hosts or parsed.username or parsed.password or parsed.port not in {None, 443} or parsed.fragment:
        raise UpdateError("lookup", "Unsafe or unsupported upstream URL")
    return url


def _repository(policy: dict) -> tuple[str, str, str]:
    url = _https(policy.get("repo"), {"github.com"})
    match = re.fullmatch(r"/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)\.git", urllib.parse.urlsplit(url).path)
    if not match:
        raise UpdateError("lookup", "Unsupported GitHub repository URL")
    return url, match[1], match[2]


def read_upstream_json(url: str) -> dict:
    _https(url, {"registry.npmjs.org", "api.github.com"})
    request = urllib.request.Request(url, headers={
        "Accept": "application/vnd.npm.install-v1+json" if "registry.npmjs.org" in url else "application/vnd.github+json",
        "User-Agent": "roche-pi-dependency-updater",
    })
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = response.read(20 * 1024 * 1024 + 1)
        if len(payload) > 20 * 1024 * 1024:
            raise ValueError("Response too large")
        result = json.loads(payload)
        if not isinstance(result, dict):
            raise ValueError("Expected an object")
        return result
    except (OSError, ValueError) as error:
        raise UpdateError("lookup", "Upstream JSON lookup failed") from error


def _command(command: list[str], run, stage: str, root: Path | None = None) -> str:
    try:
        result = run(command, cwd=root, text=True, capture_output=True, check=False,
                     timeout=600, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
    except (OSError, subprocess.SubprocessError) as error:
        raise UpdateError(stage, f"{command[0]} could not complete") from error
    if result.returncode:
        raise UpdateError(stage, f"{command[0]} failed (exit {result.returncode}): {result.stderr[-1000:]}")
    return result.stdout


def remote_refs(url: str) -> str:
    _https(url, {"github.com"})
    return _command(["git", "ls-remote", "--symref", url, "HEAD", "refs/tags/*"], subprocess.run, "lookup")


def select_stable_tag(refs: str) -> tuple[str, str]:
    tags, peeled = {}, {}
    for line in refs.splitlines():
        sha, separator, ref = line.partition("\t")
        if not separator or not SHA.fullmatch(sha) or not ref.startswith("refs/tags/"):
            continue
        tag = ref.removeprefix("refs/tags/")
        target = peeled if tag.endswith("^{}") else tags
        tag = tag.removesuffix("^{}")
        if _stable(tag.removeprefix("v")):
            target[tag] = sha
    if not tags:
        raise UpdateError("lookup", "No stable release tag found")
    tag = max(tags, key=lambda value: (_version_key(value), "+" not in value, value))
    return tag, peeled.get(tag, tags[tag])


def _npm_metadata(package: str, read_json) -> dict:
    if not isinstance(package, str) or not re.fullmatch(r"(?:@[a-z0-9._-]+/)?[a-z0-9._-]+", package):
        raise UpdateError("lookup", "Invalid npm package name")
    metadata = read_json("https://registry.npmjs.org/" + urllib.parse.quote(package, safe="@"))
    if not isinstance(metadata, dict) or metadata.get("name") != package or not isinstance(metadata.get("versions"), dict) or not isinstance(metadata.get("dist-tags", {}), dict):
        raise UpdateError("lookup", "Registry metadata has an invalid package or version map")
    return metadata


def _npm_version(package: str, metadata: dict, version: str) -> dict:
    try:
        entry = metadata["versions"][version]
        if metadata["name"] != package or entry["name"] != package or entry["version"] != version or not _stable(version):
            raise ValueError()
        return {"version": version, "url": _https(entry["dist"]["tarball"], {"registry.npmjs.org"})}
    except (KeyError, TypeError, ValueError) as error:
        raise UpdateError("lookup", "Stable npm version metadata is missing or inconsistent") from error


def resolve_source(policy: dict, current: dict, read_json=read_upstream_json, ls_remote=remote_refs) -> dict:
    channel = policy.get("channel")
    if channel == "npm-latest":
        package = policy["package"]
        metadata = _npm_metadata(package, read_json)
        return _npm_version(package, metadata, metadata.get("dist-tags", {}).get("latest"))
    if channel not in {"git-stable-tag", "git-default-head"}:
        raise UpdateError("lookup", "Unsupported primary source channel")
    url, owner, repo = _repository(policy)
    refs = ls_remote(url)
    if channel == "git-stable-tag":
        tag, commit = select_stable_tag(refs)
        return {"rev": tag, "version": tag.removeprefix("v"), "commit_sha": commit}
    heads = [line.partition("\t")[0] for line in refs.splitlines() if line.endswith("\tHEAD") and SHA.fullmatch(line.partition("\t")[0])]
    if len(heads) != 1:
        raise UpdateError("lookup", "Default Git branch did not resolve to one commit")
    result = {"rev": heads[0]}
    if policy.get("version_style") == "commit-date":
        metadata = read_json(f"https://api.github.com/repos/{owner}/{repo}/commits/{heads[0]}")
        try:
            date = datetime.datetime.fromisoformat(metadata["commit"]["committer"]["date"])
            if metadata["sha"] != heads[0] or date.tzinfo is None:
                raise ValueError()
            result["commit_date"] = date.date().isoformat()
        except (KeyError, TypeError, ValueError) as error:
            raise UpdateError("lookup", "Commit date metadata does not match the selected revision") from error
    return result


def resolve_companion(policy: dict, manifests: dict[str, dict], locks: dict[str, dict], read_json=read_upstream_json, run=subprocess.run) -> dict:
    primary, rule = policy["primary"], policy["rule"]
    try:
        if rule == "lock-version":
            version = locks[primary]["packages"]["node_modules/" + policy["dependency"]]["version"]
            if not _stable(version):
                raise ValueError()
            _, owner, repo = _repository(policy)
            asset = policy["asset"]
            if not re.fullmatch(r"[A-Za-z0-9_.-]+", asset):
                raise ValueError()
            return {"version": version, "url": f"https://github.com/{owner}/{repo}/releases/download/v{version}/{asset}"}
        package = policy["package"]
        metadata = _npm_metadata(package, read_json)
        if rule == "same-version":
            return _npm_version(package, metadata, manifests[primary]["version"])
        if rule != "manifest-range":
            raise ValueError()
        manifest = manifests[primary]
        ranges = [manifest.get(field, {}).get(policy["dependency"]) for field in ("dependencies", "optionalDependencies", "peerDependencies")]
        declared = next((value for value in ranges if isinstance(value, str) and value), None)
        versions = [value for value in metadata["versions"] if _stable(value)]
        if declared is None or not versions or declared.startswith("-"):
            raise ValueError()
        output = _command(["semver", "--range", declared, *versions], run, "lookup")
        matching = [value for value in output.splitlines() if value in versions]
        if not matching:
            raise ValueError()
        return _npm_version(package, metadata, max(matching, key=_version_key))
    except (KeyError, TypeError, ValueError) as error:
        raise UpdateError("lookup", "Companion version cannot be resolved from its consumer") from error


def _sri(value: str, root: Path, run) -> str:
    if isinstance(value, str) and value.startswith("sha256-"):
        return check_hash(value, "source-hash")
    if not isinstance(value, str) or not re.fullmatch(r"[0-9abcdfghijklmnpqrsvwxyz]{52}|[0-9a-f]{64}", value):
        raise UpdateError("source-hash", "Malformed prefetch hash")
    output = _command(["nix", "hash", "convert", "--hash-algo", "sha256", "--to", "sri", value], run, "source-hash", root)
    return check_hash(output.strip(), "source-hash")


def prefetch_source(root: Path, policy: dict, resolved: dict, run=subprocess.run) -> tuple[dict, Path]:
    fetcher = policy["fetcher"]
    fields = dict(resolved)
    try:
        if fetcher == "fetchgit":
            url, _, _ = _repository(policy)
            revision = resolved.get("commit_sha", resolved["rev"])
            command = ["nix-prefetch-git", "--url", url, "--rev", revision]
            if policy.get("submodules", True):
                command.append("--fetch-submodules")
            body = json.loads(_command(command, run, "source-hash", root))
            if not SHA.fullmatch(body["rev"]) or SHA.fullmatch(revision) and body["rev"] != revision:
                raise ValueError()
            value, path = body.get("hash", body.get("sha256")), body["path"]
        elif fetcher in {"fetchzip", "github-archive"}:
            if fetcher == "github-archive":
                _, owner, repo = _repository(policy)
                url = f"https://github.com/{owner}/{repo}/archive/{urllib.parse.quote(resolved['rev'], safe='')}.tar.gz"
            else:
                url = _https(resolved["url"], {"registry.npmjs.org"})
            lines = _command(["nix-prefetch-url", "--unpack", "--print-path", url], run, "source-hash", root).splitlines()
            if len(lines) != 2:
                raise ValueError()
            value, path = lines
        elif fetcher == "fetchurl":
            url = _https(resolved["url"], {"registry.npmjs.org", "github.com"})
            body = json.loads(_command(["nix", "store", "prefetch-file", "--json", url], run, "source-hash", root))
            value, path = body["hash"], body["storePath"]
        else:
            raise ValueError()
        fetched = Path(path)
        if not fetched.is_absolute() or not (fetched.is_file() if fetcher == "fetchurl" else fetched.is_dir()):
            raise ValueError()
        fields[policy["hash_field"]] = _sri(value, root, run)
        return fields, fetched
    except (KeyError, TypeError, ValueError) as error:
        raise UpdateError("source-hash", "Prefetch returned invalid source metadata") from error
