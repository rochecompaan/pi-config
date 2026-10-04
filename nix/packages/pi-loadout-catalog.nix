{
  pkgs,
  pi,
  configPackage,
  suiteRoots,
}:
let
  suiteRootsJson = pkgs.writeText "pi-loadout-suite-roots.json" (builtins.toJSON suiteRoots);
  probe = ../check-support/pi-skillset-probe.ts;
in
pkgs.runCommand "pi-loadout-catalog.json"
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
      ln -s "${configPackage}/$resource" "$agent_dir/$resource"
    done

    run_probe() {
      if ! "$@" > "$TMPDIR/probe.log" 2>&1; then
        cat "$TMPDIR/probe.log"
        exit 1
      fi
    }

    # Deferred MCP servers connect in the background. Await them through the
    # built-in command before capturing the complete SDK tool catalog.
    mapfile -t mcp_prompts < <(python - "$agent_dir/mcp.json" <<'PY'
    import json
    import sys

    with open(sys.argv[1]) as source:
        servers = json.load(source).get("mcpServers", {})
    for name, server in sorted(servers.items()):
        if server.get("enabled", True):
            print(f"/mcp reconnect {name}")
    PY
    )

    run_probe env PI_SKILLSET_PROBE_OUTPUT="$TMPDIR/skills.json" \
      ${pi}/bin/pi --no-session --extension ${probe} \
      -p "''${mcp_prompts[@]}" /write-skillset-probe
    # Some extensions register tools only in before_agent_start. Reach that
    # boundary with a local provider that records the catalog, then stops.
    if env PI_BOOTSTRAP_PROBE_OUTPUT="$TMPDIR/tools.json" \
      ${pi}/bin/pi --no-session \
      --extension ${../check-support/pi-bootstrap-probe.ts} \
      --provider pi-bootstrap-probe --model probe \
      -p "''${mcp_prompts[@]}" "Inspect the complete tool catalog." \
      > "$TMPDIR/probe.log" 2>&1
    then
      echo "catalog probe did not stop in its local provider" >&2
      exit 1
    fi
    if ! ${pkgs.gnugrep}/bin/grep -Fq PI_BOOTSTRAP_PROBE_STOP "$TMPDIR/probe.log" \
      || ${pkgs.gnugrep}/bin/grep -Eq \
        'Failed to load extension|Extension error|Cannot find package' "$TMPDIR/probe.log"
    then
      cat "$TMPDIR/probe.log"
      exit 1
    fi

    python ${../lib/loadout_presets.py} catalog \
      "$TMPDIR/skills.json" "$TMPDIR/tools.json" ${suiteRootsJson} > "$out"
  ''
