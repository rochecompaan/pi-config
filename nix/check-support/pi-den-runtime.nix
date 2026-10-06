{
  pkgs,
  piDen,
  piConfig,
  bundle,
  probeExtension,
  bootstrapProbe,
}:

pkgs.runCommand "pi-den-runtime"
  {
    nativeBuildInputs = [ pkgs.coreutils pkgs.diffutils pkgs.gnugrep pkgs.jq pkgs.python3 ];
    manifest = piDen.denPackage.denManifest;
    denPi = piDen.denPackage;
    denSettings = piDen.denSettings;
    piDenEnvironment = builtins.toJSON piDen.environment;
    bundlePackages = builtins.toJSON (map toString bundle.denResources.pi.packages);
    inherit piDen piConfig probeExtension bootstrapProbe;
  }
  ''
    set -euo pipefail

    # Den keeps argument, signal, and status handling behind one command name.
    # pi-den only adds Pi's environment before it hands over to Den.
    test "$(ls "$piDen/bin")" = pi-den
    grep -Fq "exec \"$denPi/bin/pi\"" "$piDen/bin/pi-den"
    for name in $(jq -r 'keys[]' <<< "$piDenEnvironment"); do
      grep -Fq "export $name=" "$piDen/bin/pi-den"
    done

    python3 - <<'PY'
    import json
    import os

    manifest = json.load(open(os.environ["manifest"]))
    settings = json.load(open(os.environ["denSettings"]))

    # A Den Pi update must fail here until pi-den moves to the same version.
    policy = manifest["agent"]["argumentPolicy"]
    assert policy == "pi-" + settings["lastChangelogVersion"], (policy, settings["lastChangelogVersion"])
    assert "packages" not in settings, sorted(settings)

    bindings = {binding["name"]: binding for binding in manifest["stateBindings"]}
    destinations = sorted(f["destination"] for f in bindings["agent"]["managedFiles"])
    assert destinations == sorted([
        "settings.json",
        "AGENTS.md",
        "mcp.json",
        "claude-bridge.json",
        "loadout.json",
        "loadout-profiles.json",
        "agents",
        "profiles/pi-subagents/openai.json",
        "profiles/pi-subagents/kimi.json",
    ]), destinations
    assert bindings["session"]["managedFiles"] == [], bindings["session"]

    args = manifest["agent"]["resourceArgs"]
    extensions = [args[i + 1] for i in range(len(args) - 1) if args[i] == "--extension"]
    packages = json.loads(os.environ["bundlePackages"])
    assert [entry for entry in extensions if entry in packages] == packages, extensions
    PY

    mkdir -p "$TMPDIR/home" "$TMPDIR/workspace"
    export HOME="$TMPDIR/home"
    export PI_CODING_AGENT_DIR="$TMPDIR/pi-agent"
    export PI_CODING_AGENT_SESSION_DIR="$TMPDIR/pi-sessions"
    # Test-only RepoWolf values. Inside a Nix build Den stops at its /tmp
    # scratch-root check, after managed restoration and before Fence.
    export REPOWOLF_ENDPOINT=https://broker.example.test/
    export REPOWOLF_TOKEN=rw1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
    printf certificate > "$TMPDIR/ca.pem"
    chmod 0400 "$TMPDIR/ca.pem"
    export REPOWOLF_CA_FILE="$TMPDIR/ca.pem"
    cd "$TMPDIR/workspace"

    launch() {
      log=$1
      status=0
      timeout 20 "$piDen/bin/pi-den" --provider __invalid__ -p ok > "$log" 2>&1 || status=$?
      if [ "$status" -eq 124 ]; then
        cat "$log" >&2
        echo 'pi-den timed out' >&2
        exit 1
      fi
      if [ "$status" -eq 0 ]; then
        cat "$log" >&2
        echo 'pi-den accepted an invalid provider' >&2
        exit 1
      fi
    }

    require_managed_links() {
      jq -r '.stateBindings[] | select(.name == "agent") | .managedFiles[] | "\(.destination) \(.source)"' \
        "$manifest" > "$TMPDIR/managed-files"
      while read -r destination source; do
        if [ "$(readlink "$PI_CODING_AGENT_DIR/$destination")" != "$source" ]; then
          echo "managed link is not restored: $destination" >&2
          exit 1
        fi
      done < "$TMPDIR/managed-files"
    }

    launch "$TMPDIR/fresh.log"
    require_managed_links

    printf '%s' '{"openai":{"type":"api_key","key":"sk-den-check"}}' > "$TMPDIR/expected-auth.json"
    printf custom > "$TMPDIR/expected-custom.json"
    cp "$TMPDIR/expected-auth.json" "$PI_CODING_AGENT_DIR/auth.json"
    cp "$TMPDIR/expected-custom.json" "$PI_CODING_AGENT_DIR/profiles/pi-subagents/custom.json"
    rm "$PI_CODING_AGENT_DIR/settings.json"
    printf replacement > "$PI_CODING_AGENT_DIR/settings.json"
    launch "$TMPDIR/replacement.log"
    require_managed_links
    cmp "$TMPDIR/expected-auth.json" "$PI_CODING_AGENT_DIR/auth.json"
    cmp "$TMPDIR/expected-custom.json" "$PI_CODING_AGENT_DIR/profiles/pi-subagents/custom.json"

    # Start Den's Pi outside Fence with the manifest's and pi-den's environment
    # and the manifest's resources, so the probes see exactly what pi-den gives
    # Pi.
    agentExecutable=$(jq -r .agent.executable "$manifest")
    mapfile -t resourceArgs < <(jq -r '.agent.resourceArgs[]' "$manifest")
    mapfile -t agentEnvironment < <(jq -r '
      .agent.packageDirectory as $package
      | (.agent.environment.set | to_entries[] | "\(.key)=\(.value)"),
        "\($package.name)=\($package.value)"
    ' "$manifest"; jq -r 'to_entries[] | "\(.key)=\(.value)"' <<< "$piDenEnvironment")

    run_pi() {
      log=$1
      shift
      status=0
      env "''${agentEnvironment[@]}" timeout 60 "$agentExecutable" "''${resourceArgs[@]}" "$@" \
        > "$log" 2>&1 || status=$?
      for failure in "Failed to load extension" "No such built-in module" "Cannot find package"; do
        if grep -Fq "$failure" "$log"; then
          cat "$log" >&2
          exit 1
        fi
      done
      if [ "$status" -eq 124 ]; then
        cat "$log" >&2
        echo 'Den Pi probe timed out' >&2
        exit 1
      fi
      return "$status"
    }

    # Fence lets Pi write only to its selected state, worktree and scratch
    # directories. A read-only HOME makes any extension that writes there fail
    # to load, as it would inside the sandbox.
    chmod 0555 "$HOME"

    PI_SKILLSET_PROBE_OUTPUT="$TMPDIR/pi-resources.json" \
      run_pi "$TMPDIR/pi-resources.log" \
      --no-session --no-tools --extension "$probeExtension" -p /write-skillset-probe

    status=0
    PI_BOOTSTRAP_PROBE_OUTPUT="$TMPDIR/pi-loadout.json" \
      run_pi "$TMPDIR/pi-loadout.log" \
      --no-session --extension "$bootstrapProbe" \
      --provider pi-bootstrap-probe --model probe -p "Inspect selection." || status=$?
    if [ "$status" -eq 0 ] || ! grep -Fq PI_BOOTSTRAP_PROBE_STOP "$TMPDIR/pi-loadout.log"; then
      cat "$TMPDIR/pi-loadout.log" >&2
      echo 'bootstrap probe did not stop in its local provider' >&2
      exit 1
    fi

    python3 - "$TMPDIR/pi-resources.json" "$TMPDIR/pi-loadout.json" <<'PY'
    import json
    import os
    import sys
    from pathlib import Path

    resources = json.load(open(sys.argv[1]))
    required = {"context-mode", "pi-subagents", "using-superpowers", "commit", "nix-config"}
    assert required <= set(resources["skills"]), resources["skills"]

    # The managed default loadout decides which skills the model sees.
    agent = Path(os.environ["PI_CODING_AGENT_DIR"])
    selection = json.loads((agent / "loadout.json").read_text())
    catalog = json.loads((Path(os.environ["piConfig"]) / "loadout-catalog.json").read_text())
    expected = sorted(set(selection["enabledSkills"]) - set(catalog["manualSkills"]))
    result = json.load(open(sys.argv[2]))
    assert result["skills"] == expected, (result["skills"], expected)
    assert result["bootstrap"] == (selection.get("profileName") == "superpowers"), result
    PY

    # Extension data follows the selected agent directory.
    for state in context-mode/sessions intervals remote-pi/.pi/remote/skills/agent-network; do
      if [ ! -d "$PI_CODING_AGENT_DIR/$state" ]; then
        echo "extension state is not in the agent directory: $state" >&2
        exit 1
      fi
    done
    chmod 0755 "$HOME"

    mkdir "$TMPDIR/outside" "$TMPDIR/expected-outside"
    printf outside > "$TMPDIR/expected-outside/sentinel"
    cp "$TMPDIR/expected-outside/sentinel" "$TMPDIR/outside/sentinel"
    rm -rf "$PI_CODING_AGENT_DIR/profiles"
    ln -s "$TMPDIR/outside" "$PI_CODING_AGENT_DIR/profiles"
    launch "$TMPDIR/rejected.log"
    if ! grep -Eq 'managed state "profiles/pi-subagents/[a-z]+\.json": parent is a symbolic link' \
      "$TMPDIR/rejected.log"
    then
      cat "$TMPDIR/rejected.log" >&2
      echo 'pi-den did not reject the profiles parent symlink' >&2
      exit 1
    fi
    diff -r "$TMPDIR/expected-outside" "$TMPDIR/outside"

    touch "$out"
  ''
