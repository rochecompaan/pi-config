"""Missing npm integrity follows the upstream lock, not hard-coded versions."""

import base64
import copy
import json
import unittest

from maintenance.dependency_updates.model import UpdateError
from maintenance.dependency_updates.npm_integrity import repair_lock_integrity

INTEGRITY = "sha512-" + base64.b64encode(bytes(range(64))).decode()
URL = "https://registry.npmjs.org/@scope/core/-/core-0.99.1.tgz"
ENTRY = "node_modules/consumer/node_modules/@scope/core"


class IntegrityRepairTests(unittest.TestCase):
    def setUp(self):
        self.lock = {"lockfileVersion": 3, "packages": {
            "": {"name": "consumer", "version": "1.0.0"},
            ENTRY: {"version": "0.99.1", "resolved": URL, "dev": True},
            "node_modules/already-complete": {"version": "2.0.0", "integrity": "existing"},
        }}
        self.metadata = {"name": "@scope/core", "version": "0.99.1",
            "dist": {"tarball": URL, "integrity": INTEGRITY}}
        self.requests = []

    def read_json(self, url):
        self.requests.append(url)
        if url != "https://registry.npmjs.org/%40scope%2Fcore":
            raise AssertionError(url)
        return {"versions": {"0.99.1": copy.deepcopy(self.metadata)}}

    def test_adds_only_missing_integrity_for_the_exact_locked_version(self):
        original = copy.deepcopy(self.lock)
        result = json.loads(repair_lock_integrity(json.dumps(self.lock).encode(), self.read_json))
        expected = copy.deepcopy(original)
        expected["packages"][ENTRY]["integrity"] = INTEGRITY
        self.assertEqual(result, expected)
        self.assertEqual(self.lock, original)
        self.assertEqual(self.requests, ["https://registry.npmjs.org/%40scope%2Fcore"])

    def test_complete_lock_is_byte_identical_without_registry_access(self):
        self.lock["packages"][ENTRY]["integrity"] = INTEGRITY
        content = json.dumps(self.lock, separators=(",", ":")).encode()
        self.assertEqual(repair_lock_integrity(content, self.read_json), content)
        self.assertEqual(self.requests, [])

    def test_unsafe_or_unknown_tarballs_stop_before_registry_access(self):
        urls = [URL.replace("https:", "http:"), URL.replace("registry.npmjs.org", "evil.example"),
            URL.replace("registry.npmjs.org", "user:password@registry.npmjs.org"),
            URL + "?token=private", URL + "#fragment", "file:/tmp/package.tgz", None]
        for url in urls:
            with self.subTest(url=url):
                self.lock["packages"][ENTRY]["resolved"] = url
                with self.assertRaises(UpdateError):
                    repair_lock_integrity(json.dumps(self.lock).encode(), self.read_json)
        self.assertEqual(self.requests, [])

    def test_registry_identity_version_or_tarball_mismatch_is_rejected(self):
        for field, value in (("name", "@scope/other"), ("version", "1.0.0"),
                ("dist", {"tarball": "https://evil.example/core.tgz", "integrity": INTEGRITY})):
            with self.subTest(field=field):
                self.metadata[field] = value
                with self.assertRaises(UpdateError):
                    repair_lock_integrity(json.dumps(self.lock).encode(), self.read_json)
                self.setUp()

    def test_invalid_registry_integrity_is_rejected(self):
        for integrity in (None, "", "sha512-invalid", "sha512-YQ==", True):
            with self.subTest(integrity=integrity):
                self.metadata["dist"]["integrity"] = integrity
                with self.assertRaises(UpdateError):
                    repair_lock_integrity(json.dumps(self.lock).encode(), self.read_json)

    def test_link_entries_do_not_require_registry_integrity(self):
        self.lock["packages"][ENTRY] = {"resolved": "packages/core", "link": True}
        content = json.dumps(self.lock).encode()
        self.assertEqual(repair_lock_integrity(content, self.read_json), content)
        self.assertEqual(self.requests, [])

    def test_malformed_lock_is_a_lockfile_error(self):
        for content in (b"not json", b"[]", b"{}", b'{"packages": []}'):
            with self.subTest(content=content):
                with self.assertRaises(UpdateError) as raised:
                    repair_lock_integrity(content, self.read_json)
                self.assertEqual(raised.exception.stage, "lockfile")


if __name__ == "__main__":
    unittest.main()
