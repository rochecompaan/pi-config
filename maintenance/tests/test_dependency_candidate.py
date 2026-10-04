import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from maintenance.dependency_updates.model import UpdateError, load_catalog
from maintenance.dependency_updates.candidate import prepare, read_report, validate, write_report

OLD_HASH = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE="
NEW_HASH = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAI="
SHA = "b" * 40


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.workspace = Path(self.directory.name)
        self.root = self.workspace / "repo"
        self.root.mkdir()
        (self.root / "nix/packages").mkdir(parents=True)
        (self.root / "maintenance/dependency_updates").mkdir(parents=True)
        self.pins = {"a": {"rev": "v1.0.0", "hash": OLD_HASH}, "b": {"rev": "v1.0.0", "hash": OLD_HASH}}
        (self.root / "nix/dependency-pins.json").write_text(json.dumps(self.pins))
        self.catalog = {"sources": {
            key: {"fetcher": "fetchgit", "hash_field": "hash", "channel": "git-stable-tag",
                  "repo": f"https://github.com/example/{key}.git", "submodules": True}
            for key in ("a", "b")
        }, "units": {
            "one": {"sources": ["a"], "builds": ["pkg"], "paths": ["nix/dependency-pins.json"]},
            "two": {"sources": ["b"], "builds": [], "paths": ["nix/dependency-pins.json"]},
            "flake-inputs": {"sources": [], "builds": [], "paths": ["flake.lock"]},
        }}
        self.save_catalog()
        (self.root / "flake.lock").write_text('{"version":7,"nodes":{}}\n')
        (self.root / ".gitignore").write_text('__pycache__/\n')
        (self.root / "nix/packages/pi-deps.nix").write_text(
            '# dependency-source: a\n srcA = pkgs.fetchgit {};\n# dependency-source: b\n srcB = pkgs.fetchgit {};\n')
        for name in ("pi-remote", "pi-intervals"):
            (self.root / f"nix/packages/{name}.nix").write_text("")
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("config", "user.name", "Fixture")
        self.commit()
        self.fetched = self.workspace / "fetched"
        self.fetched.mkdir()
        self.commands = []
        self.sandbox = True
        self.hash = NEW_HASH

    def save_catalog(self):
        (self.root / "maintenance/dependency_updates/catalog.json").write_text(json.dumps(self.catalog))

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.root, capture_output=True, text=True, check=True).stdout.strip()

    def commit(self):
        self.git("add", ".")
        self.git("commit", "-qm", "Fixture")
        self.base = self.git("rev-parse", "HEAD")
        self.units, _ = load_catalog(self.root)

    def runner(self, command, **kwargs):
        self.commands.append(command)
        if command[0] == "nix-prefetch-git":
            output = json.dumps({"rev": SHA, "path": str(self.fetched), "hash": self.hash})
        elif command[:3] == ["nix", "config", "show"]:
            output = json.dumps({"sandbox": {"value": self.sandbox}})
        elif command[:2] == ["nix", "eval"]:
            output = '["pkg", "unused"]'
        elif command[:3] == ["nix", "flake", "update"]:
            (Path(kwargs["cwd"]) / "flake.lock").write_text('{"version":7,"nodes":{"changed":{}}}\n')
            output = ""
        else:
            output = ""
        return subprocess.CompletedProcess(command, 0, output, "")

    def make_candidate(self, unit="one", refs=None):
        return prepare(self.root, self.units[unit], "main", self.base, self.runner,
                       lambda url: {}, lambda url: refs or f"{SHA}\trefs/tags/v2.0.0")

    def test_prepare_changes_only_owned_source_and_captures_tree(self):
        candidate = self.make_candidate()
        pins = json.loads((self.root / "nix/dependency-pins.json").read_text())
        self.assertEqual(pins["a"]["rev"], "v2.0.0")
        self.assertEqual(pins["b"], {"rev": "v1.0.0", "hash": OLD_HASH})
        self.assertEqual(candidate.tree_sha, self.git("write-tree"))
        self.assertEqual(candidate.paths, ("nix/dependency-pins.json",))
        self.assertTrue(candidate.changed)
        self.assertFalse(candidate.validated)

    def test_same_source_does_not_regenerate_npm_lock(self):
        self.catalog["sources"]["a"].update(package="pkg", lock={"kind": "upstream"})
        self.pins["a"].update(version="1.0.0", npmDepsHash=OLD_HASH)
        (self.root / "nix/dependency-pins.json").write_text(json.dumps(self.pins))
        self.save_catalog()
        self.commit()
        self.hash = OLD_HASH
        candidate = self.make_candidate(refs=f"{SHA}\trefs/tags/v1.0.0")
        self.assertFalse(candidate.changed)
        self.assertEqual(self.git("status", "--porcelain"), "")
        self.assertFalse(any(command[0] in {"npm", "prefetch-npm-deps"} for command in self.commands))

    def test_retagged_stable_source_is_not_mistaken_for_no_change(self):
        candidate = self.make_candidate(refs=f"{SHA}\trefs/tags/v1.0.0")
        self.assertTrue(candidate.changed)
        self.assertEqual(json.loads((self.root / "nix/dependency-pins.json").read_text())["a"]["hash"], NEW_HASH)

    def test_dirty_checkout_is_not_reset(self):
        path = self.root / "flake.lock"
        path.write_text("user work")
        with self.assertRaises(UpdateError):
            self.make_candidate()
        self.assertEqual(path.read_text(), "user work")

    def test_failed_flake_update_rolls_back_owned_changes(self):
        def fail(command, **kwargs):
            result = self.runner(command, **kwargs)
            if command[:3] == ["nix", "flake", "update"]:
                return subprocess.CompletedProcess(command, 1, "", "lookup failed")
            return result
        with self.assertRaises(UpdateError):
            prepare(self.root, self.units["flake-inputs"], "main", self.base, fail, None, None)
        self.assertEqual(self.git("status", "--porcelain"), "")

    def test_flake_unit_cannot_change_pin_records(self):
        def malicious(command, **kwargs):
            result = self.runner(command, **kwargs)
            if command[:3] == ["nix", "flake", "update"]:
                (self.root / "nix/dependency-pins.json").write_text('{"unexpected":true}')
            return result
        with self.assertRaises(UpdateError):
            prepare(self.root, self.units["flake-inputs"], "main", self.base, malicious, None, None)
        self.assertEqual((self.root / "nix/dependency-pins.json").read_text(), '{"unexpected":true}')
        self.assertEqual(self.git("diff", "--", "flake.lock"), "")

    def test_success_marks_only_exact_tree_validated(self):
        candidate = self.make_candidate()
        result = validate(self.root, self.units["one"], candidate, self.runner)
        self.assertTrue(result.validated)
        self.assertFalse(candidate.validated)

    def test_failed_gate_preserves_unvalidated_candidate(self):
        candidate = self.make_candidate()
        with self.assertRaises(UpdateError) as raised:
            validate(self.root, self.units["one"], candidate,
                     lambda command, **kwargs: subprocess.CompletedProcess(command, 1, "", "failed"))
        self.assertEqual(raised.exception.stage, "validation")
        self.assertFalse(candidate.validated)

    def test_non_sandboxed_runner_can_validate_all_required_gates(self):
        candidate = self.make_candidate()
        self.commands.clear()
        self.sandbox = False

        def without_sandbox(command, **kwargs):
            result = self.runner(command, **kwargs)
            if "sandbox" in command and command[command.index("sandbox") + 1] != "false":
                return subprocess.CompletedProcess(command, 1, "", "Sandbox unavailable on this runner")
            return result

        result = validate(self.root, self.units["one"], candidate, without_sandbox)
        self.assertTrue(result.validated)
        self.assertFalse(candidate.validated)
        self.assertTrue(any(".#packages.x86_64-linux.pkg" in command for command in self.commands))
        self.assertTrue(any(".#checks.x86_64-linux.pi-config-extension-load" in command for command in self.commands))
        self.assertTrue(any(command[:3] == ["nix", "flake", "check"] for command in self.commands))

    def test_build_mutation_cannot_be_validated(self):
        candidate = self.make_candidate()
        def mutate(command, **kwargs):
            if command[:2] == ["nix", "build"]:
                (self.root / "flake.lock").write_text("changed during check")
            return self.runner(command, **kwargs)
        with self.assertRaises(UpdateError):
            validate(self.root, self.units["one"], candidate, mutate)
        self.assertFalse(candidate.validated)

    def test_flake_validation_builds_outputs_not_covered_by_checks(self):
        candidate = self.make_candidate("flake-inputs")
        result = validate(self.root, self.units["flake-inputs"], candidate, self.runner)
        self.assertTrue(result.validated)
        self.assertTrue(any(".#packages.x86_64-linux.unused" in command for command in self.commands))

    def test_failed_report_is_not_readable_as_a_candidate(self):
        path = self.workspace / "candidate.json"
        write_report(path, None, UpdateError("lookup", "unavailable"))
        with self.assertRaises(UpdateError):
            read_report(path)

    def test_empty_error_record_is_rejected(self):
        candidate = self.make_candidate()
        path = self.workspace / "candidate.json"
        write_report(path, candidate)
        data = json.loads(path.read_text())
        data["error"] = {}
        path.write_text(json.dumps(data))
        with self.assertRaises(UpdateError):
            read_report(path)

    def test_report_round_trip_keeps_validation_state(self):
        candidate = self.make_candidate()
        path = self.workspace / "candidate.json"
        write_report(path, candidate)
        self.assertEqual(read_report(path), candidate)
        self.assertFalse(read_report(path).validated)

    def test_dry_run_cli_keeps_original_checkout_clean(self):
        package = Path(__file__).resolve().parents[1]
        shutil.copytree(package, self.root / "maintenance", dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("__pycache__", "catalog.json", "tests"))
        (self.root / "maintenance/__init__.py").write_text("")
        self.commit()
        bin_dir = self.workspace / "bin"
        bin_dir.mkdir()
        fake = bin_dir / "nix"
        fake.write_text(f'#!{sys.executable}\nfrom pathlib import Path\nPath("flake.lock").write_text(\'{{"version":7,"nodes":{{"new":{{}}}}}}\')\n')
        fake.chmod(0o755)
        report = self.workspace / "dry-run.json"
        output = self.workspace / "github-output"
        result = subprocess.run([sys.executable, "-m", "maintenance.dependency_updates", "prepare", "flake-inputs",
            "--base", "main", "--base-sha", self.base, "--report", str(report), "--dry-run"], cwd=self.root,
            env={**os.environ, "PATH": str(bin_dir) + os.pathsep + os.environ["PATH"], "GITHUB_OUTPUT": str(output)},
            capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git("status", "--porcelain"), "")
        self.assertTrue(read_report(report).changed)
        self.assertFalse(read_report(report).validated)
        self.assertIn("changed=true", output.read_text())


if __name__ == "__main__":
    unittest.main()
