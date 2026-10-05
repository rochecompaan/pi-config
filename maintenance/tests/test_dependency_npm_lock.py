import base64
import copy
import io
import json
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path

from maintenance.dependency_updates.model import UpdateError
from maintenance.dependency_updates.npm_lock import (
    effective_manifest, refresh_npm_lock, source_manifest,
)

HASH = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQ="


def lock_for(manifest):
    return {"name": manifest["name"], "version": manifest["version"],
            "lockfileVersion": 3, "requires": True, "packages": {"": copy.deepcopy(manifest)}}


class ManifestPolicyTests(unittest.TestCase):
    def test_pi_remote_strips_build_dependencies_without_mutating_source(self):
        original = {"name": "@noahsaso/pi-remote", "version": "0.3.1",
            "dependencies": {"ws": "^8.0.0"}, "devDependencies": {"typescript": "^5.0.0"},
            "scripts": {"install": "exit 99"}}
        result = effective_manifest("pi-remote", original)
        self.assertNotIn("devDependencies", result)
        self.assertEqual(result["scripts"], {})
        self.assertEqual(result["dependencies"], {"ws": "^8.0.0"})
        self.assertIn("devDependencies", original)

    def test_remote_extension_keeps_host_dependencies_until_post_install(self):
        original = {"name": "remote-pi", "version": "1.0.0",
            "dependencies": {"@earendil-works/pi-coding-agent": "^0.87.0"}}
        result = effective_manifest("remote-pi-extension", original)
        self.assertEqual(result["dependencies"], {"@earendil-works/pi-coding-agent": "^0.87.0"})
        self.assertNotIn("peerDependencies", result)

    def test_raw_archive_manifest_is_read_without_extraction(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.tgz"
            content = b'{"name":"pkg","version":"1.0.0"}'
            with tarfile.open(path, "w:gz") as archive:
                member = tarfile.TarInfo("package/package.json")
                member.size = len(content)
                archive.addfile(member, io.BytesIO(content))
            self.assertEqual(source_manifest(path, "fetchurl"), {"name": "pkg", "version": "1.0.0"})
            self.assertFalse((Path(directory) / "package").exists())

    def test_archive_symlink_manifest_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.tgz"
            with tarfile.open(path, "w:gz") as archive:
                member = tarfile.TarInfo("package/package.json")
                member.type = tarfile.SYMTYPE
                member.linkname = "../../private.json"
                archive.addfile(member)
            with self.assertRaises(UpdateError):
                source_manifest(path, "fetchurl")

    def test_directory_manifest_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "private.json").write_text('{"name":"pkg","version":"1.0.0"}')
            (root / "source").mkdir()
            (root / "source/package.json").symlink_to(root / "private.json")
            with self.assertRaises(UpdateError):
                source_manifest(root / "source", "fetchgit")


class LockRefreshTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.manifest = {"name": "pkg", "version": "1.1.0", "dependencies": {"lib": "^1.0.0"}}
        (self.source / "package.json").write_text(json.dumps(self.manifest))
        self.seed = lock_for({"name": "pkg", "version": "1.0.0", "dependencies": {"lib": "^1.0.0"}})
        self.seed["packages"]["node_modules/lib"] = {"version": "1.2.3", "resolved": "https://registry.npmjs.org/lib/-/lib-1.2.3.tgz"}
        (self.root / "pkg-package-lock.json").write_text(json.dumps(self.seed))
        self.policy = {"fetcher": "fetchgit", "lock": {"kind": "maintained", "path": "pkg-package-lock.json"}}

    def fake_run(self, command, **kwargs):
        cwd = Path(kwargs["cwd"])
        if command[0] == "npm":
            if "--ignore-scripts" not in command or "--package-lock-only" not in command:
                return subprocess.CompletedProcess(command, 1, "", "Unsafe install request")
            path = cwd / "package-lock.json"
            manifest = json.loads((cwd / "package.json").read_text())
            lock = json.loads(path.read_text()) if path.exists() else lock_for(manifest)
            lock["name"], lock["version"] = manifest["name"], manifest["version"]
            lock["packages"][""] = manifest
            if "node_modules/lib" not in lock["packages"]:
                lock["packages"]["node_modules/lib"] = {"version": "1.9.0"}
            path.write_text(json.dumps(lock))
            output = ""
        elif command[0] == "prefetch-npm-deps":
            output = HASH + "\n"
        else:
            raise AssertionError(command)
        return subprocess.CompletedProcess(command, 0, output, "")

    def test_maintained_lock_preserves_seeded_transitive_version(self):
        content, digest = refresh_npm_lock(self.root, "pkg", self.source, self.policy, self.fake_run)
        result = json.loads(content)
        self.assertEqual(result["packages"]["node_modules/lib"]["version"], "1.2.3")
        self.assertEqual(result["packages"][""]["version"], "1.1.0")
        self.assertEqual(digest, HASH)
        self.assertEqual(json.loads((self.root / "pkg-package-lock.json").read_text())["version"], "1.0.0")

    def test_missing_upstream_lock_is_an_error(self):
        self.policy["lock"] = {"kind": "upstream"}
        with self.assertRaises(UpdateError) as raised:
            refresh_npm_lock(self.root, "pkg", self.source, self.policy, self.fake_run)
        self.assertEqual(raised.exception.stage, "lockfile")

    def test_upstream_lock_is_preserved_without_source_mutation(self):
        self.policy["lock"] = {"kind": "upstream"}
        original = json.dumps(lock_for(self.manifest)).encode()
        (self.source / "package-lock.json").write_bytes(original)
        content, digest = refresh_npm_lock(self.root, "pkg", self.source, self.policy, self.fake_run)
        self.assertEqual(content, original)
        self.assertEqual((self.source / "package-lock.json").read_bytes(), original)
        self.assertEqual(digest, HASH)

    def test_repaired_upstream_uses_current_lock_versions_without_npm_install(self):
        self.policy["lock"] = {"kind": "repaired-upstream", "path": "pkg-package-lock.json"}
        lock = lock_for(self.manifest)
        url = "https://registry.npmjs.org/lib/-/lib-1.8.0.tgz"
        lock["packages"]["node_modules/lib"] = {"version": "1.8.0", "resolved": url}
        original = json.dumps(lock).encode()
        (self.source / "package-lock.json").write_bytes(original)
        integrity = "sha512-" + base64.b64encode(bytes(range(64))).decode()

        def read_json(request):
            self.assertEqual(request, "https://registry.npmjs.org/lib")
            return {"versions": {"1.8.0": {"name": "lib", "version": "1.8.0",
                "dist": {"tarball": url, "integrity": integrity}}}}

        def prefetch_only(command, **kwargs):
            self.assertEqual(command[0], "prefetch-npm-deps")
            return self.fake_run(command, **kwargs)

        content, digest = refresh_npm_lock(self.root, "pkg", self.source, self.policy, prefetch_only, read_json)
        result = json.loads(content)
        self.assertEqual(result["packages"]["node_modules/lib"],
            {"version": "1.8.0", "resolved": url, "integrity": integrity})
        self.assertEqual(digest, HASH)
        self.assertEqual((self.source / "package-lock.json").read_bytes(), original)

    def test_inconsistent_root_declarations_are_rejected(self):
        self.policy["lock"] = {"kind": "upstream"}
        (self.source / "package-lock.json").write_text(json.dumps(self.seed))
        with self.assertRaises(UpdateError) as raised:
            refresh_npm_lock(self.root, "pkg", self.source, self.policy, self.fake_run)
        self.assertEqual(raised.exception.stage, "lockfile")

    def test_patch_failure_is_not_worked_around(self):
        self.policy["lock"] = {"kind": "patched-upstream", "patch": "integrity.patch"}
        (self.source / "package-lock.json").write_text(json.dumps(lock_for(self.manifest)))
        (self.root / "integrity.patch").write_text("not a patch")
        with self.assertRaises(UpdateError) as raised:
            refresh_npm_lock(self.root, "pkg", self.source, self.policy,
                lambda command, **kwargs: subprocess.CompletedProcess(command, 1, "", "patch failed"))
        self.assertEqual(raised.exception.stage, "lockfile")
        self.assertEqual((self.root / "integrity.patch").read_text(), "not a patch")

    def test_invalid_cache_hash_is_rejected(self):
        def bad_hash(command, **kwargs):
            if command[0] == "prefetch-npm-deps":
                return subprocess.CompletedProcess(command, 0, "not-a-hash\n", "")
            return self.fake_run(command, **kwargs)
        with self.assertRaises(UpdateError) as raised:
            refresh_npm_lock(self.root, "pkg", self.source, self.policy, bad_hash)
        self.assertEqual(raised.exception.stage, "npm-hash")

    def test_real_npm_does_not_execute_prepare_script(self):
        sentinel = self.root / "lifecycle-ran"
        manifest = {"name": "pkg", "version": "1.0.0", "scripts": {
            "prepare": "node -e " + json.dumps("require('fs').writeFileSync(" + json.dumps(str(sentinel)) + ", 'unsafe')")
        }}
        (self.source / "package.json").write_text(json.dumps(manifest))
        (self.root / "pkg-package-lock.json").write_text(json.dumps(lock_for(manifest)))
        def actual_npm(command, **kwargs):
            if command[0] == "prefetch-npm-deps":
                return subprocess.CompletedProcess(command, 0, HASH + "\n", "")
            return subprocess.run(command, **kwargs)
        content, _ = refresh_npm_lock(self.root, "pkg", self.source, self.policy, actual_npm)
        self.assertEqual(json.loads(content)["packages"][""]["version"], "1.0.0")
        self.assertFalse(sentinel.exists())


if __name__ == "__main__":
    unittest.main()
