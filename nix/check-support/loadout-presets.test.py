import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


BUILDER = Path(__file__).resolve().parents[1] / "lib" / "loadout_presets.py"


class LoadoutPresetsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.catalog = {
            "tools": ["omega", "alpha", "omega"],
            "skills": ["core", "super-a", "super-b", "matt-a", "matt-b"],
            "suites": {
                "superpowers": ["super-a", "super-b"],
                "matt": ["matt-a", "matt-b"],
            },
        }
        self.config = {
            "defaultProfile": "superpowers",
            "profiles": {
                "superpowers": {
                    "suites": ["superpowers"],
                    "extraSkills": ["matt-a"],
                },
                "matt": {"suites": ["matt"]},
            },
        }

    def write_json(self, name, value):
        path = self.root / name
        path.write_text(json.dumps(value), encoding="utf-8")
        return path

    def render(self):
        return subprocess.run(
            [
                sys.executable, str(BUILDER), "render",
                str(self.write_json("catalog.json", self.catalog)),
                str(self.write_json("config.json", self.config)),
                str(self.root / "output"),
            ],
            capture_output=True, text=True,
        )

    def read_output(self, name):
        return json.loads((self.root / "output" / name).read_text())

    def test_presets_keep_shared_skills_and_all_tools_without_leaking_suites(self):
        result = self.render()
        self.assertEqual(result.returncode, 0, result.stderr)
        profiles = self.read_output("loadout-profiles.json")["profiles"]
        self.assertEqual(
            profiles["superpowers"]["enabledSkills"],
            ["core", "matt-a", "super-a", "super-b"],
        )
        self.assertEqual(
            profiles["matt"]["enabledSkills"], ["core", "matt-a", "matt-b"],
        )
        for profile in profiles.values():
            self.assertEqual(profile["enabledTools"], ["alpha", "omega"])

    def test_default_is_a_real_selection_not_just_a_profile_label(self):
        self.config["defaultProfile"] = "matt"
        result = self.render()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.read_output("loadout.json"), {
            "enabledTools": ["alpha", "omega"],
            "enabledSkills": ["core", "matt-a", "matt-b"],
            "profileName": "matt",
        })

    def test_unknown_extra_skill_fails_without_replacing_existing_files(self):
        self.config["profiles"]["matt"]["extraSkills"] = ["missing-skill"]
        output = self.root / "output"
        output.mkdir()
        original = '{"keep":"existing-default"}'
        (output / "loadout.json").write_text(original)
        result = self.render()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing-skill", result.stderr)
        self.assertEqual((output / "loadout.json").read_text(), original)
        self.assertFalse((output / "loadout-profiles.json").exists())

    def test_unknown_suite_is_rejected(self):
        self.config["profiles"]["matt"]["suites"] = ["missing-suite"]
        result = self.render()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing-suite", result.stderr)

    def test_unknown_default_profile_is_rejected(self):
        self.config["defaultProfile"] = "missing-profile"
        result = self.render()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing-profile", result.stderr)

    def test_empty_tool_catalog_cannot_silently_disable_every_tool(self):
        self.catalog["tools"] = []
        result = self.render()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("tools", result.stderr.lower())

    def test_catalog_uses_loaded_skill_names_and_exact_package_boundaries(self):
        resources = self.write_json("resources.json", {
            "skills": ["renamed-skill", "super-a", "core"],
            "skillFiles": {
                "renamed-skill": "/packages/matt/old-directory/SKILL.md",
                "super-a": "/packages/superpowers/super-a/SKILL.md",
                "core": "/packages/matt-other/core/SKILL.md",
            },
        })
        tools = self.write_json("tools.json", {
            "all": ["omega", "alpha", "omega", "pi_loadout_codemode_only"], "active": ["alpha"],
        })
        suites = self.write_json("suites.json", {
            "matt": "/packages/matt", "superpowers": "/packages/superpowers",
        })
        result = subprocess.run(
            [sys.executable, str(BUILDER), "catalog", str(resources),
             str(tools), str(suites)],
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {
            "tools": ["alpha", "omega"],
            "skills": ["core", "renamed-skill", "super-a"],
            "suites": {
                "matt": ["renamed-skill"], "superpowers": ["super-a"],
            },
        })


if __name__ == "__main__":
    unittest.main()
