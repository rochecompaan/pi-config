{ ... }:
{
  perSystem =
    {
      pkgs,
      self',
      ...
    }:
    let
      piConfig = self'.packages.pi-config;
      selectablePi = self'.packages.pi;
      fixedMattPi = self'.packages.pi-matt;
      mattSkills = self'.packages.mattpocock-skills;
      probeExtension = ../../nix/check-support/pi-skillset-probe.ts;
    in
    {
      # Keep the shared Home Manager-like fixture and three launch paths together.
      # Event observation lives in the focused TypeScript probe.
      checks.pi-config-extension-load =
        pkgs.runCommand "pi-config-extension-load"
          {
            nativeBuildInputs = [ pkgs.python3 ];
          }
          ''
            export HOME="$TMPDIR/home"
            agent_dir="$HOME/.pi/agent"
            mkdir -p "$agent_dir"

            ln -s ${piConfig}/AGENTS.md "$agent_dir/AGENTS.md"
            ln -s ${piConfig}/settings.json "$agent_dir/settings.json"
            ln -s ${piConfig}/mcp.json "$agent_dir/mcp.json"
            ln -s ${piConfig}/claude-bridge.json "$agent_dir/claude-bridge.json"
            ln -s ${piConfig}/extensions "$agent_dir/extensions"
            ln -s ${piConfig}/agents "$agent_dir/agents"
            ln -s ${piConfig}/multi-model-planning-teams "$agent_dir/multi-model-planning-teams"
            ln -s ${piConfig}/skills "$agent_dir/skills"
            ln -s ${piConfig}/themes "$agent_dir/themes"
            ln -s ${piConfig}/node_modules "$agent_dir/node_modules"

            check_load_failures() {
              log="$1"
              for failure in \
                "Failed to load extension" \
                "Extension does not export a valid factory function" \
                "No such built-in module" \
                "Cannot find package"
              do
                if ${pkgs.gnugrep}/bin/grep -Fq "$failure" "$log"; then
                  cat "$log"
                  return 1
                fi
              done
            }

            run_probe() {
              name="$1"
              shift

              set +e
              "$@" > "$TMPDIR/$name.log" 2>&1
              status=$?
              set -e

              check_load_failures "$TMPDIR/$name.log"

              if [ "$status" -ne 0 ]; then
                cat "$TMPDIR/$name.log"
                return "$status"
              fi
            }

            run_probe superpowers \
              ${pkgs.coreutils}/bin/env \
              PI_SKILLSET_PROBE_OUTPUT="$TMPDIR/superpowers.json" \
              ${selectablePi}/bin/pi \
              --no-session \
              --no-tools \
              --extension ${probeExtension} \
              -p /write-skillset-probe

            run_probe matt \
              ${pkgs.coreutils}/bin/env \
              ROCHE_PI_SKILLSET=matt \
              PI_SKILLSET_PROBE_OUTPUT="$TMPDIR/matt.json" \
              ${selectablePi}/bin/pi \
              --no-session \
              --no-tools \
              --extension ${probeExtension} \
              -p /write-skillset-probe

            run_probe matt-convenience \
              ${pkgs.coreutils}/bin/env \
              ROCHE_PI_SKILLSET=superpowers \
              PI_SKILLSET_PROBE_OUTPUT="$TMPDIR/matt-convenience.json" \
              ${fixedMattPi}/bin/pi-matt \
              --no-session \
              --no-tools \
              --extension ${probeExtension} \
              -p /write-skillset-probe

            run_probe ask-claude \
              ${pkgs.coreutils}/bin/env \
              PI_TOOLSET_PROBE_OUTPUT="$TMPDIR/ask-claude-tools.json" \
              ${selectablePi}/bin/pi \
              --no-session \
              --no-builtin-tools \
              --extension ${probeExtension} \
              -p /write-toolset-probe

            python3 - "$TMPDIR/ask-claude-tools.json" <<'PY'
            import json
            import sys

            with open(sys.argv[1], encoding="utf-8") as f:
                tools = json.load(f)

            assert "AskClaude" in tools["all"], tools
            assert "AskClaude" in tools["active"], tools
            PY

            set +e
            ${pkgs.coreutils}/bin/env \
              ANTHROPIC_API_KEY=pi-skillset-probe \
              PI_SUPERPOWERS_BOOTSTRAP_OUTPUT="$TMPDIR/superpowers-bootstrap.txt" \
              ${selectablePi}/bin/pi \
              --no-session \
              --no-tools \
              --extension ${probeExtension} \
              --provider anthropic \
              --model claude-sonnet-4-5 \
              -p "Verify Superpowers bootstrap" \
              > "$TMPDIR/superpowers-bootstrap.log" 2>&1
            bootstrap_status=$?
            set -e

            check_load_failures "$TMPDIR/superpowers-bootstrap.log"

            if [ "$bootstrap_status" -eq 0 ]; then
              cat "$TMPDIR/superpowers-bootstrap.log"
              echo "bootstrap probe reached an external provider instead of stopping" >&2
              exit 1
            fi

            if ! ${pkgs.gnugrep}/bin/grep -Fq \
              "PI_SKILLSET_PROBE_STOP" \
              "$TMPDIR/superpowers-bootstrap.log"
            then
              cat "$TMPDIR/superpowers-bootstrap.log"
              echo "bootstrap probe did not stop before the provider request" >&2
              exit 1
            fi

            if ! ${pkgs.gnugrep}/bin/grep -Fxq \
              "superpowers:using-superpowers bootstrap for pi" \
              "$TMPDIR/superpowers-bootstrap.txt"
            then
              cat "$TMPDIR/superpowers-bootstrap.log"
              echo "Superpowers bootstrap marker was not observed" >&2
              exit 1
            fi

            python3 - \
              "$TMPDIR/superpowers.json" \
              "$TMPDIR/matt.json" \
              "$TMPDIR/matt-convenience.json" \
              "${mattSkills}" \
              <<'PY'
            import json
            import sys
            from pathlib import Path

            superpowers_path, matt_path, matt_convenience_path, matt_skills_path = sys.argv[1:5]
            with open(superpowers_path, encoding="utf-8") as f:
                superpowers = json.load(f)
            with open(matt_path, encoding="utf-8") as f:
                matt = json.load(f)
            with open(matt_convenience_path, encoding="utf-8") as f:
                matt_convenience = json.load(f)

            matt_skill_names = {
                skill_file.parent.name
                for skill_file in Path(matt_skills_path).glob("skills/*/*/SKILL.md")
            }

            def validate_shape(name, profile):
                assert isinstance(profile["skills"], list), f"{name}: skills must be a list"
                assert profile["skills"] == sorted(profile["skills"]), (
                    f"{name}: skills must be sorted"
                )
                assert len(profile["skills"]) == len(set(profile["skills"])), (
                    f"{name}: skills must not contain duplicate names"
                )
                assert all(isinstance(skill, str) for skill in profile["skills"]), (
                    f"{name}: every skill name must be a string"
                )
                assert isinstance(profile["appendSystemPrompt"], str), (
                    f"{name}: appendSystemPrompt must be a string"
                )

            def require(name, profile, names):
                missing = sorted(set(names) - set(profile["skills"]))
                assert not missing, f"{name}: missing skills: {missing}"

            def forbid(name, profile, names):
                unexpected = sorted(set(names) & set(profile["skills"]))
                assert not unexpected, f"{name}: unexpected skills: {unexpected}"

            validate_shape("superpowers", superpowers)
            validate_shape("matt", matt)
            validate_shape("matt-convenience", matt_convenience)
            assert matt_convenience == matt, "pi-matt resources differ from Matt selector mode"
            require("matt-convenience", matt_convenience, [
                "codebase-design",
                "domain-modeling",
                "simple-english",
            ])

            require("superpowers", superpowers, [
                "codebase-design",
                "domain-modeling",
                "using-superpowers",
                "writing-plans",
                "test-driven-development",
                "pi-subagents",
                "context-mode",
                "intervals-time-entries",
                "simple-english",
            ])
            forbid("superpowers", superpowers, ["tdd", "implement", "code-review"])
            superpowers_matt_skills = matt_skill_names & set(superpowers["skills"])
            assert superpowers_matt_skills == {"codebase-design", "domain-modeling"}, (
                "superpowers: unexpected Matt skills: "
                f"{sorted(superpowers_matt_skills - {'codebase-design', 'domain-modeling'})}; "
                "missing selected Matt skills: "
                f"{sorted({'codebase-design', 'domain-modeling'} - superpowers_matt_skills)}"
            )
            assert "[roche-pi skillset: superpowers]" in superpowers["appendSystemPrompt"]

            require("matt", matt, [
                "codebase-design",
                "domain-modeling",
                "tdd",
                "implement",
                "code-review",
                "pi-subagents",
                "context-mode",
                "intervals-time-entries",
                "simple-english",
            ])
            forbid("matt", matt, [
                "using-superpowers",
                "writing-plans",
                "test-driven-development",
            ])
            assert "[roche-pi skillset: matt]" in matt["appendSystemPrompt"]
            PY

            touch "$out"
          '';
    };
}
