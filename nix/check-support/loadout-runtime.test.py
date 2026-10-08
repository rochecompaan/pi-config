"""Check loadout behavior in a real Pi process without calling a remote model."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


PI = os.environ["PI_LOADOUT_TEST_PI"]
CONFIG = Path(os.environ["PI_LOADOUT_TEST_CONFIG"])
PROBE = os.environ["PI_LOADOUT_TEST_PROBE"]


class LoadoutRuntimeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="pi-loadout-runtime-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.agent = self.populate(self.root / "home" / ".pi" / "agent")
        self.catalog = json.loads((CONFIG / "loadout-catalog.json").read_text())
        self.profiles = json.loads((CONFIG / "loadout-profiles.json").read_text())["profiles"]

    def populate(self, agent):
        agent.mkdir(parents=True)
        for resource in CONFIG.iterdir():
            if resource.name == "loadout.json":
                (agent / resource.name).write_text(resource.read_text())
            else:
                (agent / resource.name).symlink_to(resource)
        return agent

    def select_default(self, profile, agent=None):
        selection = {**self.profiles[profile], "profileName": profile}
        ((agent or self.agent) / "loadout.json").write_text(json.dumps(selection))

    def make_writable(self, path):
        content = path.read_bytes()
        path.unlink()
        path.write_bytes(content)
        return content

    def probe(self, commands=(), flags=(), before_reconnect=(), env=None):
        output = self.root / "probe.json"
        env = {
            **os.environ,
            "HOME": str(self.root / "home"),
            "PI_BOOTSTRAP_PROBE_OUTPUT": str(output),
            **(env or {}),
        }
        result = subprocess.run(
            [PI, "--no-session", "--extension", PROBE,
             "--provider", "pi-bootstrap-probe", "--model", "probe", *flags,
             "-p", *before_reconnect, "/mcp reconnect context-mode", *commands,
             "Inspect selection."],
            cwd=self.root, env=env, text=True, capture_output=True, timeout=60,
        )
        log = result.stdout + result.stderr
        self.assertIn("PI_BOOTSTRAP_PROBE_STOP", log)
        self.assertNotEqual(result.returncode, 0)
        for error in ["Failed to load extension", "Extension error", "Cannot find package"]:
            self.assertNotIn(error, log)
        self.assertTrue(output.exists(), log)
        return json.loads(output.read_text())

    def assert_profile(self, result, profile):
        selected = self.profiles[profile]
        visible_skills = sorted(
            set(selected["enabledSkills"]) - set(self.catalog["manualSkills"])
        )
        self.assertEqual(result["skills"], visible_skills)
        self.assertEqual(result["active"], selected["enabledTools"])
        self.assertEqual(result["bootstrap"], profile == "superpowers")

    def test_default_superpowers_keeps_tools_and_skills_loaded_after_session_start(self):
        result = self.probe()
        self.assertIn("agent-network", result["skills"])
        self.assertIn("subagents_enable", result["active"])
        self.assertIn("mcp__context_mode__ctx_execute", result["active"])
        self.assert_profile(result, "superpowers")

    def test_default_matt_keeps_late_resources_without_superpowers(self):
        self.select_default("matt")
        self.assert_profile(self.probe(), "matt")

    def test_named_profile_switch_overrides_the_startup_selection(self):
        self.assert_profile(self.probe(commands=["/loadout use matt"]), "matt")

    def test_named_switch_before_mcp_connects_preserves_the_new_selection(self):
        result = self.probe(before_reconnect=["/loadout use matt"])
        self.assert_profile(result, "matt")

    def test_saved_skills_filter_an_earlier_forced_system_prompt(self):
        # Other packages override the prompt before loadout filters its skills.
        (self.agent / "loadout.json").write_text(json.dumps({
            "enabledTools": ["read"], "enabledSkills": ["tdd"],
        }))
        result = self.probe()
        self.assertEqual(result["skills"], ["tdd"])
        self.assertFalse(result["bootstrap"])

    def test_restricted_saved_tools_are_not_reenabled_by_later_startup_steps(self):
        selection = json.loads((self.agent / "loadout.json").read_text())
        selection["enabledTools"] = ["read"]
        (self.agent / "loadout.json").write_text(json.dumps(selection))
        self.assertEqual(self.probe()["active"], ["read"])

    def test_explicit_cli_tool_selection_still_wins(self):
        self.assertEqual(self.probe(flags=["--tools", "read"])["active"], ["read"])

    def test_no_tools_flag_still_wins(self):
        self.assertEqual(self.probe(flags=["--no-tools"])["active"], [])

    def test_no_skills_flag_disables_configured_skills(self):
        # Extension-injected skills are separate from configured discovery.
        skills = self.probe(flags=["--no-skills"])["skills"]
        for configured in ["commit", "tdd", "domain-modeling"]:
            self.assertNotIn(configured, skills)

    def test_nix_managed_profiles_reject_save_without_an_extension_error(self):
        path = self.agent / "loadout-profiles.json"
        original = path.read_bytes()
        self.assert_profile(self.probe(commands=["/loadout save blocked"]), "superpowers")
        self.assertEqual(path.read_bytes(), original)

    def test_nix_managed_profiles_reject_delete_without_an_extension_error(self):
        path = self.agent / "loadout-profiles.json"
        original = path.read_bytes()
        self.assert_profile(self.probe(commands=["/loadout delete matt"]), "superpowers")
        self.assertEqual(path.read_bytes(), original)

    def test_agent_dir_override_supplies_the_default_loadout(self):
        custom = self.populate(self.root / "custom-agent")
        self.select_default("matt", custom)
        result = self.probe(env={"PI_CODING_AGENT_DIR": str(custom)})
        self.assert_profile(result, "matt")

    def test_agent_dir_override_receives_saved_presets(self):
        custom = self.populate(self.root / "custom-agent")
        self.make_writable(custom / "loadout-profiles.json")
        home_profiles = self.make_writable(self.agent / "loadout-profiles.json")
        self.probe(
            commands=["/loadout save local"],
            env={"PI_CODING_AGENT_DIR": str(custom)},
        )
        saved = json.loads((custom / "loadout-profiles.json").read_text())
        self.assertIn("local", saved["profiles"])
        self.assertEqual((self.agent / "loadout-profiles.json").read_bytes(), home_profiles)

    def test_writable_profiles_save_selected_names_before_registration_finishes(self):
        path = self.agent / "loadout-profiles.json"
        self.make_writable(path)
        self.probe(commands=["/loadout save local"])
        saved = json.loads(path.read_text())["profiles"]["local"]
        self.assertEqual(sorted(saved["enabledTools"]), self.profiles["superpowers"]["enabledTools"])
        self.assertEqual(sorted(saved["enabledSkills"]), self.profiles["superpowers"]["enabledSkills"])

    def test_builtin_full_preset_expands_against_the_ready_catalog(self):
        (self.agent / "loadout.json").write_text(json.dumps({
            "enabledTools": [], "enabledSkills": [], "profileName": "full",
        }))
        result = self.probe()
        self.assertIn("agent-network", result["skills"])
        indirect = {name for name, exposure in result["exposures"].items()
                    if exposure in {"codemode", "deferred"}}
        expected = set(result["all"]) - indirect - {"pi_loadout_codemode_only"}
        self.assertEqual(result["active"], sorted(expected))
        self.assertIn("mcp__context_mode__ctx_execute", result["all"])
        self.assertNotIn("mcp__context_mode__ctx_execute", result["active"])


if __name__ == "__main__":
    unittest.main()
