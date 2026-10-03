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
      pi = self'.packages.pi;
      mattSkills = self'.packages.mattpocock-skills;
      probeExtension = ../../nix/check-support/pi-skillset-probe.ts;
      bootstrapProbe = ../../nix/check-support/pi-bootstrap-probe.ts;
    in
    {
      checks.pi-config-extension-load =
        pkgs.runCommand "pi-config-extension-load"
          {
            nativeBuildInputs = [ pkgs.python3 ];
          }
          ''
            export HOME="$TMPDIR/home"
            agent_dir="$HOME/.pi/agent"
            mkdir -p "$agent_dir"

            for resource in AGENTS.md settings.json mcp.json claude-bridge.json \
              extensions agents multi-model-planning-teams skills themes node_modules
            do
              ln -s "${piConfig}/$resource" "$agent_dir/$resource"
            done

            check_load_failures() {
              log="$1"
              for failure in \
                "Failed to load extension" \
                "Extension does not export a valid factory function" \
                "Extension error" \
                "No such built-in module" \
                "Cannot find package" \
                "Host-provided extension packages must be declared"
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

            remote_pi_dir="$(python3 - "${piConfig}/settings.json" <<'PY'
            import json
            import sys
            with open(sys.argv[1], encoding="utf-8") as f:
                packages = json.load(f)["packages"]
            sources = [p if isinstance(p, str) else p["source"] for p in packages]
            print(next(source for source in sources if source.endswith("/remote-pi")))
            PY
            )"
            run_probe remote-pi-cli \
              ${pkgs.nodejs}/bin/node "$remote_pi_dir/dist/index.js" --help
            ${pkgs.gnugrep}/bin/grep -Fq \
              "Usage: remote-pi <command>" "$TMPDIR/remote-pi-cli.log"

            run_probe resources \
              ${pkgs.coreutils}/bin/env \
              PI_SKILLSET_PROBE_OUTPUT="$TMPDIR/resources.json" \
              ${pi}/bin/pi --no-session --no-tools \
              --extension ${probeExtension} -p /write-skillset-probe

            python3 - "$TMPDIR/resources.json" "${mattSkills}" <<'PY'
            import json
            import sys
            from pathlib import Path
            with open(sys.argv[1], encoding="utf-8") as f:
                resources = json.load(f)
            skills = resources["skills"]
            assert skills == sorted(set(skills)), resources
            required = {
                "using-superpowers", "writing-plans", "test-driven-development",
                "tdd", "implement", "code-review", "codebase-design", "domain-modeling",
                "pi-subagents", "context-mode", "intervals-time-entries", "simple-english",
            }
            matt_names = {
                path.parent.name
                for path in Path(sys.argv[2]).glob("skills/*/*/SKILL.md")
            }
            assert matt_names, "Matt skills package is empty"
            assert required | matt_names <= set(skills), resources
            assert resources["appendSystemPrompt"] == "", resources
            PY

            run_probe ask-claude \
              ${pkgs.coreutils}/bin/env \
              PI_TOOLSET_PROBE_OUTPUT="$TMPDIR/ask-claude-tools.json" \
              ${pi}/bin/pi --no-session --no-builtin-tools \
              --extension ${probeExtension} -p /write-toolset-probe
            python3 - "$TMPDIR/ask-claude-tools.json" <<'PY'
            import json
            import sys
            with open(sys.argv[1], encoding="utf-8") as f:
                tools = json.load(f)
            assert "AskClaude" in tools["all"], tools
            assert "AskClaude" in tools["active"], tools
            PY

            run_probe claude-bridge-models \
              ${pkgs.coreutils}/bin/env \
              PI_MODELSET_PROBE_OUTPUT="$TMPDIR/claude-bridge-models.json" \
              ${pi}/bin/pi --no-session --no-tools \
              --extension ${probeExtension} -p /write-modelset-probe
            python3 - "$TMPDIR/claude-bridge-models.json" <<'PY'
            import json
            import sys
            with open(sys.argv[1], encoding="utf-8") as f:
                models = json.load(f)
            opus_5_5 = next((m for m in models if m["id"] == "claude-opus-5-5"), None)
            assert opus_5_5 is not None, models
            assert opus_5_5["contextWindow"] == 1_000_000, opus_5_5
            PY

            run_probe context-paging-tools \
              ${pkgs.coreutils}/bin/env \
              PI_TOOLSET_PROBE_OUTPUT="$TMPDIR/context-paging-tools.json" \
              ${pi}/bin/pi --no-session \
              --extension ${probeExtension} -p /write-toolset-probe
            python3 - "$TMPDIR/context-paging-tools.json" <<'PY'
            import json
            import sys
            with open(sys.argv[1], encoding="utf-8") as f:
                tools = json.load(f)
            required = {
                "list_peers", "agent_send", "search_history", "browse_history",
                "load_history", "read_context_output",
            }
            assert required <= set(tools["all"]), tools
            assert required <= set(tools["active"]), tools
            assert "update_task_state" not in tools["all"], tools
            assert "update_task_state" not in tools["active"], tools
            PY

            run_bootstrap_probe() {
              name="$1"
              expected="$2"
              shift 2
              set +e
              PI_BOOTSTRAP_PROBE_OUTPUT="$TMPDIR/$name.json" \
                ${pi}/bin/pi --no-session --tools read \
                --extension ${bootstrapProbe} \
                --provider pi-bootstrap-probe --model probe "$@" \
                -p "Inspect Superpowers reminder" > "$TMPDIR/$name.log" 2>&1
              status=$?
              set -e
              check_load_failures "$TMPDIR/$name.log"
              if [ "$status" -eq 0 ] || ! ${pkgs.gnugrep}/bin/grep -Fq \
                "PI_BOOTSTRAP_PROBE_STOP" "$TMPDIR/$name.log"
              then
                cat "$TMPDIR/$name.log"
                echo "bootstrap probe did not stop in its local provider" >&2
                return 1
              fi
              python3 - "$TMPDIR/$name.json" "$expected" <<'PY'
            import json
            import sys
            with open(sys.argv[1], encoding="utf-8") as f:
                result = json.load(f)
            assert result["bootstrap"] == (sys.argv[2] == "true"), result
            PY
            }

            empty_decoy='<available_skills></available_skills>'
            enabled_decoy='<available_skills><skill><name>using-superpowers</name></skill></available_skills>'
            nested_empty_decoy="$(printf '<skills>\n%s\n</skills>' "$empty_decoy")"
            nested_enabled_decoy="$(printf '<skills>\n%s\n</skills>' "$enabled_decoy")"

            run_bootstrap_probe superpowers-enabled true
            run_bootstrap_probe superpowers-enabled-shadowed true \
              --append-system-prompt "$empty_decoy"
            run_bootstrap_probe superpowers-enabled-section-shadowed true \
              --append-system-prompt "$nested_empty_decoy"
            printf '%s\n' '{"enabledTools":["read"],"enabledSkills":["tdd"]}' \
              > "$agent_dir/loadout.json"
            run_bootstrap_probe superpowers-disabled false
            run_bootstrap_probe superpowers-disabled-shadowed false \
              --append-system-prompt "$enabled_decoy"
            run_bootstrap_probe superpowers-disabled-section-shadowed false \
              --append-system-prompt "$nested_enabled_decoy"
            printf '%s\n' '{"enabledTools":["read"],"enabledSkills":[]}' \
              > "$agent_dir/loadout.json"
            paired_decoy="$(printf '%s\n\n<cwd>\n/example-from-docs\n</cwd>' "$nested_enabled_decoy")"
            run_bootstrap_probe superpowers-no-skills-paired-decoy false \
              --append-system-prompt "$paired_decoy"
            paired_same_cwd_decoy="$(printf '%s\n\n<cwd>\n%s\n</cwd>' "$nested_enabled_decoy" "$PWD")"
            run_bootstrap_probe superpowers-no-skills-same-cwd-decoy false \
              --append-system-prompt "$paired_same_cwd_decoy"

            touch "$out"
          '';
    };
}
