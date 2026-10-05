"""Repair registry integrity without changing upstream dependency selection."""

import base64
import binascii
import json
import re
import urllib.parse

from .model import UpdateError
from .sources import read_upstream_json


def _registry_package(entry: dict) -> tuple[str, str, str]:
    try:
        resolved, version = entry.get("resolved"), entry.get("version")
        if not isinstance(resolved, str) or not isinstance(version, str):
            raise ValueError()
        parsed = urllib.parse.urlsplit(resolved)
        if (parsed.scheme != "https" or parsed.netloc != "registry.npmjs.org"
                or parsed.query or parsed.fragment):
            raise ValueError()
        match = re.fullmatch(r"/((?:@[a-z0-9._-]+/)?[a-z0-9._-]+)/-/([^/]+)", parsed.path)
        if not match or not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?", version):
            raise ValueError()
        name = match[1]
        if any(part in {".", ".."} for part in name.split("/")):
            raise ValueError()
        if match[2] != name.rsplit("/", 1)[-1] + "-" + version + ".tgz":
            raise ValueError()
        return name, version, resolved
    except (TypeError, ValueError) as error:
        raise UpdateError("lockfile", "Missing integrity requires a canonical npm registry tarball") from error


def _registry_integrity(name: str, version: str, resolved: str, read_json) -> str:
    # The install-v1 media type is supported by packuments, not version routes.
    url = "https://registry.npmjs.org/" + urllib.parse.quote(name, safe="")
    document = read_json(url)
    try:
        metadata = document["versions"][version]
        if not isinstance(metadata, dict) or metadata.get("name") != name or metadata.get("version") != version:
            raise ValueError()
        dist = metadata["dist"]
        if not isinstance(dist, dict) or dist.get("tarball") != resolved:
            raise ValueError()
        integrity = dist["integrity"]
        if not isinstance(integrity, str) or not integrity.startswith("sha512-"):
            raise ValueError()
        digest = base64.b64decode(integrity[7:], validate=True)
        if len(digest) != 64 or digest == bytes(64):
            raise ValueError()
        return integrity
    except (KeyError, TypeError, ValueError, binascii.Error) as error:
        raise UpdateError("lockfile", "Registry metadata does not match the locked package or SHA512 integrity") from error


def repair_lock_integrity(content: bytes, read_json=read_upstream_json) -> bytes:
    try:
        lock = json.loads(content)
        if not isinstance(lock, dict) or lock.get("lockfileVersion") not in (2, 3):
            raise ValueError()
        packages = lock["packages"]
        if not isinstance(packages, dict) or any(not isinstance(entry, dict) for entry in packages.values()):
            raise ValueError()
    except (KeyError, TypeError, ValueError) as error:
        raise UpdateError("lockfile", "Integrity repair requires a valid npm lock with package records") from error
    changed, cache = False, {}
    for path, entry in packages.items():
        if not path or entry.get("link") is True or entry.get("integrity"):
            continue
        name, version, resolved = _registry_package(entry)
        key = (name, version, resolved)
        if key not in cache:
            cache[key] = _registry_integrity(name, version, resolved, read_json)
        entry["integrity"] = cache[key]
        changed = True
    return (json.dumps(lock, indent=2) + "\n").encode() if changed else content
