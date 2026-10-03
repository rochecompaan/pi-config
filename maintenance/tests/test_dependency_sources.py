import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from maintenance.dependency_updates.model import UpdateError
from maintenance.dependency_updates.sources import (
    prefetch_source, resolve_companion, resolve_source, select_stable_tag,
)

RAW_HASH = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE="
TREE_HASH = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAI="
GIT_HASH = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM="
SHA = "a" * 40


def metadata(package, versions, latest):
    return {
        "name": package,
        "dist-tags": {"latest": latest},
        "versions": {
            version: {"name": package, "version": version, "dist": {
                "tarball": f"https://registry.npmjs.org/{package}/-/{package.rsplit('/', 1)[-1]}-{version}.tgz"
            }} for version in versions
        },
    }


class SelectionTests(unittest.TestCase):
    def test_numeric_tag_order_excludes_prerelease_and_peels_tag(self):
        refs = "\n".join([
            "a" * 40 + "\trefs/tags/v1.9.0",
            "b" * 40 + "\trefs/tags/v1.10.0",
            "c" * 40 + "\trefs/tags/v1.10.0^{}",
            "d" * 40 + "\trefs/tags/v2.0.0-rc.1",
        ])
        self.assertEqual(select_stable_tag(refs), ("v1.10.0", "c" * 40))

    def test_no_stable_tag_is_an_error(self):
        with self.assertRaises(UpdateError):
            select_stable_tag(SHA + "\trefs/tags/v1.0.0-beta.1")

    def test_npm_selection_uses_stable_latest_not_highest_unrelated_channel(self):
        data = metadata("pkg", ["1.2.3", "2.0.0-beta.1", "3.0.0"], "1.2.3")
        result = resolve_source({"channel": "npm-latest", "package": "pkg"}, {}, lambda url: data, None)
        self.assertEqual(result["version"], "1.2.3")
        self.assertEqual(result["url"], "https://registry.npmjs.org/pkg/-/pkg-1.2.3.tgz")

    def test_npm_prerelease_latest_is_not_silently_replaced(self):
        data = metadata("pkg", ["1.0.0", "2.0.0-rc.1"], "2.0.0-rc.1")
        with self.assertRaises(UpdateError):
            resolve_source({"channel": "npm-latest", "package": "pkg"}, {}, lambda url: data, None)

    def test_npm_credential_bearing_tarball_is_rejected(self):
        data = metadata("pkg", ["1.0.0"], "1.0.0")
        data["versions"]["1.0.0"]["dist"]["tarball"] = "https://secret@registry.npmjs.org/a.tgz"
        with self.assertRaises(UpdateError):
            resolve_source({"channel": "npm-latest", "package": "pkg"}, {}, lambda url: data, None)

    def test_mismatched_registry_package_is_rejected(self):
        data = metadata("wrong", ["1.0.0"], "1.0.0")
        with self.assertRaises(UpdateError):
            resolve_source({"channel": "npm-latest", "package": "pkg"}, {}, lambda url: data, None)

    def test_malformed_registry_tags_report_a_lookup_error(self):
        data = {"name": "pkg", "dist-tags": [], "versions": {}}
        with self.assertRaises(UpdateError) as raised:
            resolve_source({"channel": "npm-latest", "package": "pkg"}, {}, lambda url: data, None)
        self.assertEqual(raised.exception.stage, "lookup")

    def test_git_head_is_exact_commit_and_date_is_upstream(self):
        policy = {"channel": "git-default-head", "repo": "https://github.com/example/pkg.git", "version_style": "commit-date"}
        refs = f"ref: refs/heads/main\tHEAD\n{SHA}\tHEAD\n"
        result = resolve_source(policy, {}, lambda url: {
            "sha": SHA, "commit": {"committer": {"date": "2026-09-23T12:00:00Z"}}
        }, lambda url: refs)
        self.assertEqual(result["rev"], SHA)
        self.assertEqual(result["commit_date"], "2026-09-23")

    def test_git_commit_metadata_must_match_selected_sha(self):
        policy = {"channel": "git-default-head", "repo": "https://github.com/example/pkg.git", "version_style": "commit-date"}
        with self.assertRaises(UpdateError):
            resolve_source(policy, {}, lambda url: {"sha": "b" * 40}, lambda url: f"{SHA}\tHEAD")

    def test_manifest_range_selects_latest_compatible_stable_companion(self):
        data = metadata("binary", ["1.9.0", "1.10.0", "2.0.0", "1.11.0-beta.1"], "2.0.0")
        policy = {"primary": "consumer", "rule": "manifest-range", "dependency": "binary", "package": "binary"}
        result = resolve_companion(policy, {"consumer": {"dependencies": {"binary": "^1.0.0"}}}, {}, lambda url: data, subprocess.run)
        self.assertEqual(result["version"], "1.10.0")

    def test_platform_package_must_match_shim_version(self):
        data = metadata("binary", ["1.0.0", "2.0.0"], "2.0.0")
        result = resolve_companion({"primary": "shim", "rule": "same-version", "package": "binary"},
            {"shim": {"version": "1.0.0"}}, {}, lambda url: data, subprocess.run)
        self.assertEqual(result["version"], "1.0.0")

    def test_missing_matching_platform_package_is_an_error(self):
        data = metadata("binary", ["2.0.0"], "2.0.0")
        with self.assertRaises(UpdateError):
            resolve_companion({"primary": "shim", "rule": "same-version", "package": "binary"},
                {"shim": {"version": "1.0.0"}}, {}, lambda url: data, subprocess.run)

    def test_matrix_binary_uses_locked_version(self):
        policy = {"primary": "bridge", "rule": "lock-version", "dependency": "@matrix-org/crypto",
            "repo": "https://github.com/matrix-org/crypto.git", "asset": "crypto.node"}
        result = resolve_companion(policy, {}, {"bridge": {
            "packages": {"node_modules/@matrix-org/crypto": {"version": "0.4.0"}}
        }}, None, subprocess.run)
        self.assertEqual(result["version"], "0.4.0")
        self.assertEqual(result["url"], "https://github.com/matrix-org/crypto/releases/download/v0.4.0/crypto.node")


class PrefetchTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.archive = self.root / "source.tgz"
        self.archive.write_bytes(b"archive")
        self.tree = self.root / "source"
        self.tree.mkdir()

    def fake_run(self, command, **kwargs):
        if command[0] == "nix-prefetch-git":
            submodules = "--fetch-submodules" in command
            output = json.dumps({"url": "https://github.com/example/pkg.git", "rev": SHA,
                "date": "2026-09-23T12:00:00+00:00", "path": str(self.tree),
                "sha256": "0" * 51 + "1", "hash": GIT_HASH if submodules else RAW_HASH,
                "fetchLFS": False, "fetchSubmodules": submodules, "deepClone": False,
                "fetchTags": False, "leaveDotGit": False, "rootDir": ""})
        elif command[0] == "nix-prefetch-url":
            output = "0" * 51 + "1\n" + str(self.tree) + "\n"
        elif command[:3] == ["nix", "hash", "convert"]:
            output = TREE_HASH + "\n"
        elif command[:3] == ["nix", "store", "prefetch-file"]:
            output = json.dumps({"storePath": str(self.archive), "hash": RAW_HASH})
        else:
            raise AssertionError(f"Unexpected external command: {command}")
        return subprocess.CompletedProcess(command, 0, output, "")

    def test_raw_source_uses_file_hash(self):
        result, path = prefetch_source(self.root, {"fetcher": "fetchurl", "hash_field": "sha256"},
            {"url": "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz"}, self.fake_run)
        self.assertEqual(result["sha256"], RAW_HASH)
        self.assertEqual(path, self.archive)

    def test_unpacked_source_uses_tree_hash(self):
        result, path = prefetch_source(self.root, {"fetcher": "fetchzip", "hash_field": "hash"},
            {"url": "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz"}, self.fake_run)
        self.assertEqual(result["hash"], TREE_HASH)
        self.assertEqual(path, self.tree)

    def test_git_prefetch_preserves_submodule_policy_and_sha256_field(self):
        result, path = prefetch_source(self.root, {"fetcher": "fetchgit", "hash_field": "sha256", "submodules": True,
            "repo": "https://github.com/example/pkg.git"}, {"rev": "v1.0.0", "commit_sha": SHA}, self.fake_run)
        self.assertEqual(result["sha256"], GIT_HASH)
        self.assertEqual(path, self.tree)

    def test_github_archive_uses_recursive_hash(self):
        result, path = prefetch_source(self.root, {"fetcher": "github-archive", "hash_field": "hash",
            "repo": "https://github.com/example/pkg.git"}, {"rev": SHA}, self.fake_run)
        self.assertEqual(result["hash"], TREE_HASH)
        self.assertEqual(path, self.tree)

    def test_failed_prefetch_does_not_return_a_hash(self):
        with self.assertRaises(UpdateError) as raised:
            prefetch_source(self.root, {"fetcher": "fetchzip", "hash_field": "hash"},
                {"url": "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz"},
                lambda command, **kwargs: subprocess.CompletedProcess(command, 1, "", "404"))
        self.assertEqual(raised.exception.stage, "source-hash")

    def test_missing_prefetch_fields_are_rejected(self):
        with self.assertRaises(UpdateError):
            prefetch_source(self.root, {"fetcher": "fetchurl", "hash_field": "hash"},
                {"url": "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz"},
                lambda command, **kwargs: subprocess.CompletedProcess(command, 0, "{}", ""))


if __name__ == "__main__":
    unittest.main()
