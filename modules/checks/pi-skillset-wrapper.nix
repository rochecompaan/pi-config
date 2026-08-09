{ ... }:
{
  perSystem =
    { pkgs, ... }:
    let
      mkPiSkillsetWrapper = import ../../nix/packages/pi-skillset-wrapper.nix;

      fakePi = pkgs.writeShellApplication {
        name = "pi";
        text = ''
          : "''${PI_WRAPPER_CAPTURE:?PI_WRAPPER_CAPTURE is required}"
          printf '%s\0' "$@" > "$PI_WRAPPER_CAPTURE"
        '';
      };

      superpowersPackage = pkgs.runCommand "test-superpowers-package" { } ''
        mkdir -p "$out"
      '';
      mattPackage = pkgs.runCommand "test-matt-package" { } ''
        mkdir -p "$out"
      '';

      skillsets = {
        superpowers = {
          package = superpowersPackage;
          instructions = "[test profile: superpowers]";
        };
        matt = {
          package = mattPackage;
          instructions = "[test profile: matt] $(printf unsafe) `literal`";
        };
      };

      selectablePi = mkPiSkillsetWrapper {
        inherit pkgs skillsets;
        piPackage = fakePi;
      };
      fixedSuperpowersPi = mkPiSkillsetWrapper {
        inherit pkgs skillsets;
        piPackage = fakePi;
        allowSelection = false;
      };
      fixedMattPi = mkPiSkillsetWrapper {
        inherit pkgs skillsets;
        piPackage = fakePi;
        programName = "pi-matt";
        defaultSkillset = "matt";
        allowSelection = false;
      };
    in
    {
      checks.pi-skillset-wrapper =
        pkgs.runCommand "pi-skillset-wrapper-check"
          {
            nativeBuildInputs = [ pkgs.python3 ];
          }
          ''
            export SELECTABLE_PI=${selectablePi}/bin/pi
            export FIXED_SUPERPOWERS_PI=${fixedSuperpowersPi}/bin/pi
            export FIXED_MATT_PI=${fixedMattPi}/bin/pi-matt
            export SUPERPOWERS_PACKAGE=${superpowersPackage}
            export MATT_PACKAGE=${mattPackage}

            python3 - <<'PY'
            import os
            import pathlib
            import subprocess
            import tempfile

            def invoke(binary, args, skillset=None):
                capture = pathlib.Path(tempfile.mkstemp(prefix="pi-wrapper-")[1])
                capture.unlink()
                env = os.environ.copy()
                env["PI_WRAPPER_CAPTURE"] = str(capture)
                if skillset is None:
                    env.pop("ROCHE_PI_SKILLSET", None)
                else:
                    env["ROCHE_PI_SKILLSET"] = skillset
                result = subprocess.run([binary, *args], env=env, text=True, capture_output=True)
                captured = []
                if capture.exists():
                    captured = [part.decode() for part in capture.read_bytes().split(b"\0") if part]
                return result, captured

            def suite_args(package, instructions, *user_args):
                return [
                    "--extension", package,
                    "--append-system-prompt", instructions,
                    *user_args,
                ]

            selectable = os.environ["SELECTABLE_PI"]
            fixed_superpowers = os.environ["FIXED_SUPERPOWERS_PI"]
            fixed_matt = os.environ["FIXED_MATT_PI"]
            superpowers = os.environ["SUPERPOWERS_PACKAGE"]
            matt = os.environ["MATT_PACKAGE"]

            fixed_superpowers_script = pathlib.Path(fixed_superpowers).read_text()
            assert matt not in fixed_superpowers_script
            assert "[test profile: matt]" not in fixed_superpowers_script

            fixed_matt_script = pathlib.Path(fixed_matt).read_text()
            assert superpowers not in fixed_matt_script
            assert "[test profile: superpowers]" not in fixed_matt_script

            result, args = invoke(selectable, ["hello world"])
            assert result.returncode == 0, result.stderr
            assert args == suite_args(superpowers, "[test profile: superpowers]", "hello world")

            result, args = invoke(selectable, ["hello world"], "")
            assert result.returncode == 0, result.stderr
            assert args == suite_args(superpowers, "[test profile: superpowers]", "hello world")

            result, args = invoke(selectable, ["-p", "say ok"], "superpowers")
            assert result.returncode == 0, result.stderr
            assert args == suite_args(superpowers, "[test profile: superpowers]", "-p", "say ok")

            matt_user_args = [
                "--model",
                "openai/example",
                "hello; printf unsafe",
                "$(printf unsafe)",
            ]
            result, args = invoke(selectable, matt_user_args, "matt")
            assert result.returncode == 0, result.stderr
            assert args == suite_args(
                matt,
                "[test profile: matt] $(printf unsafe) `literal`",
                *matt_user_args,
            )

            for bypass_args in (
                ["install"],
                ["remove"],
                ["uninstall"],
                ["update", "--all"],
                ["list"],
                ["config"],
                ["auth"],
                ["--help"],
                ["-h"],
                ["--version"],
                ["-v"],
                ["--list-models", "claude"],
                ["--offline", "--list-models", "claude"],
                ["--offline", "--help"],
            ):
                result, args = invoke(selectable, list(bypass_args), "matt")
                assert result.returncode == 0, result.stderr
                assert args == list(bypass_args)

            result, args = invoke(selectable, ["--", "--list-models"], "matt")
            assert result.returncode == 0, result.stderr
            assert args == suite_args(
                matt,
                "[test profile: matt] $(printf unsafe) `literal`",
                "--",
                "--list-models",
            )

            result, args = invoke(selectable, ["hello"], "unknown")
            assert result.returncode == 2
            assert not args
            assert "unknown" in result.stderr
            assert "superpowers" in result.stderr and "matt" in result.stderr

            result, args = invoke(fixed_superpowers, ["hello"], "matt")
            assert result.returncode == 0, result.stderr
            assert args == suite_args(superpowers, "[test profile: superpowers]", "hello")

            result, args = invoke(fixed_matt, ["hello"], "superpowers")
            assert result.returncode == 0, result.stderr
            assert args == suite_args(
                matt,
                "[test profile: matt] $(printf unsafe) `literal`",
                "hello",
            )

            result, args = invoke(fixed_matt, ["--list-models", "claude"], "superpowers")
            assert result.returncode == 0, result.stderr
            assert args == ["--list-models", "claude"]
            PY

            touch "$out"
          '';
    };
}
