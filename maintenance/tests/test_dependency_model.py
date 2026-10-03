import copy
import json
import tempfile
import unittest
from pathlib import Path

from maintenance.dependency_updates.model import (
    Unit, UpdateError, audit_sources, edit_pins, load_catalog,
)

HASH = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE="


class PinEditTests(unittest.TestCase):
    def setUp(self):
        self.unit = Unit("one", ("a",), (), ("nix/dependency-pins.json",))
        self.pins = {"a": {"rev": "old", "hash": HASH}, "b": {"rev": "keep"}}

    def test_edit_preserves_unrelated_source_and_input(self):
        result = edit_pins(self.pins, self.unit, {"a": {"rev": "new"}})
        self.assertEqual(result["b"], {"rev": "keep"})
        self.assertEqual(self.pins["a"]["rev"], "old")
        self.assertEqual(result["a"]["rev"], "new")

    def test_unowned_source_is_rejected(self):
        with self.assertRaises(UpdateError):
            edit_pins(self.pins, self.unit, {"b": {"rev": "new"}})

    def test_new_fields_are_rejected(self):
        with self.assertRaises(UpdateError):
            edit_pins(self.pins, self.unit, {"a": {"unexpected": "new"}})

    def test_fake_hash_is_rejected(self):
        with self.assertRaises(UpdateError):
            edit_pins(self.pins, self.unit, {
                "a": {"hash": "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}
            })

    def test_missing_owned_source_is_rejected(self):
        with self.assertRaises(UpdateError):
            edit_pins({"b": {}}, self.unit, {})


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "maintenance/dependency_updates").mkdir(parents=True)
        (self.root / "nix/packages").mkdir(parents=True)
        self.catalog = {
            "units": {
                "one": {"sources": ["a"], "builds": ["pkg"],
                        "paths": ["nix/dependency-pins.json"]}
            },
            "sources": {
                "a": {"fetcher": "fetchgit", "channel": "git-stable-tag",
                      "repo": "https://github.com/example/pkg.git", "hash_field": "hash"}
            },
        }
        self.pins = {"a": {"rev": "v1.0.0", "hash": HASH}}
        for name in ("pi-deps.nix", "pi-remote.nix", "pi-intervals.nix"):
            (self.root / "nix/packages" / name).write_text("")
        (self.root / "nix/packages/pi-deps.nix").write_text(
            '# dependency-source: a\n  src = pkgs.fetchgit { inherit (pins.a) rev hash; };\n'
        )

    def save(self):
        (self.root / "maintenance/dependency_updates/catalog.json").write_text(
            json.dumps(self.catalog)
        )
        (self.root / "nix/dependency-pins.json").write_text(json.dumps(self.pins))

    def test_valid_inventory_loads_owned_build_targets(self):
        self.save()
        units, policies = load_catalog(self.root)
        self.assertEqual(units["one"].source_ids, ("a",))
        self.assertEqual(units["one"].builds, ("pkg",))
        self.assertEqual(policies["a"]["hash_field"], "hash")
        audit_sources(self.root, policies)

    def test_unmanaged_pin_is_not_silently_skipped(self):
        self.pins["unmanaged"] = {"hash": HASH}
        self.save()
        with self.assertRaises(UpdateError):
            load_catalog(self.root)

    def test_duplicate_source_ownership_is_rejected(self):
        self.catalog["units"]["two"] = copy.deepcopy(self.catalog["units"]["one"])
        self.save()
        with self.assertRaises(UpdateError):
            load_catalog(self.root)

    def test_unknown_fetcher_is_rejected(self):
        self.catalog["sources"]["a"]["fetcher"] = "unsupported"
        self.save()
        with self.assertRaises(UpdateError):
            load_catalog(self.root)

    def test_traversal_in_owned_paths_is_rejected(self):
        self.catalog["units"]["one"]["paths"] = ["../secret"]
        self.save()
        with self.assertRaises(UpdateError):
            load_catalog(self.root)

    def test_invalid_unit_id_is_rejected(self):
        self.catalog["units"]["--force"] = self.catalog["units"].pop("one")
        self.save()
        with self.assertRaises(UpdateError):
            load_catalog(self.root)

    def test_companion_cannot_precede_its_primary(self):
        self.catalog["sources"]["a"].update(channel="companion", primary="b", rule="same-version")
        self.catalog["sources"]["b"] = {"fetcher": "fetchgit", "channel": "git-stable-tag",
            "repo": "https://github.com/example/pkg.git", "hash_field": "hash"}
        self.catalog["units"]["one"]["sources"].append("b")
        self.pins["b"] = {"rev": "v1.0.0", "hash": HASH}
        self.save()
        with self.assertRaises(UpdateError):
            load_catalog(self.root)

    def test_unknown_companion_rule_is_rejected(self):
        self.catalog["sources"]["b"] = {
            "fetcher": "fetchzip", "channel": "companion", "hash_field": "hash",
            "package": "binary", "primary": "a", "rule": "guess-latest",
        }
        self.catalog["units"]["one"]["sources"].append("b")
        self.pins["b"] = {"version": "1.0.0", "hash": HASH}
        self.save()
        with self.assertRaises(UpdateError):
            load_catalog(self.root)

    def test_wrong_hash_field_is_rejected(self):
        self.catalog["sources"]["a"]["hash_field"] = "sha256"
        self.save()
        with self.assertRaises(UpdateError):
            load_catalog(self.root)

    def test_unmarked_fetcher_is_rejected(self):
        with (self.root / "nix/packages/pi-deps.nix").open("a") as f:
            f.write('\n new = pkgs.fetchzip { url = "https://example.com/new"; };')
        self.save()
        _, policies = load_catalog(self.root)
        with self.assertRaises(UpdateError):
            audit_sources(self.root, policies)

    def test_marker_with_wrong_fetcher_is_rejected(self):
        (self.root / "nix/packages/pi-deps.nix").write_text(
            '# dependency-source: a\n  src = pkgs.fetchurl { inherit (pins.a) hash; };\n'
        )
        self.save()
        _, policies = load_catalog(self.root)
        with self.assertRaises(UpdateError):
            audit_sources(self.root, policies)


if __name__ == "__main__":
    unittest.main()
