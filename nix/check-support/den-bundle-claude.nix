{ pkgs, claude, bundle }:

assert bundle.denResources.pi ? packages;
assert bundle.denResources.claude ? skills;
assert bundle.denResources.claude.mcpServers ? context-mode;
pkgs.runCommand "den-bundle-claude"
  {
    nativeBuildInputs = [ pkgs.coreutils pkgs.gnugrep pkgs.jq pkgs.python3 ];
    claudeManifest = claude.denManifest;
    contextModeCommand = bundle.denResources.claude.mcpServers.context-mode.command;
  }
  ''
    set -euo pipefail

    test -e ${claude.resourceDiagnostics}

    cat > "$TMPDIR/check-resources.py" <<'PY'
    import json
    import os
    from pathlib import Path

    args = json.loads(Path(os.environ["claudeManifest"]).read_text())["agent"]["resourceArgs"]
    context_mode_command = os.environ["contextModeCommand"]

    pairs = []
    index = 0
    while index < len(args):
        flag = args[index]
        if flag in ("--plugin-dir", "--mcp-config"):
            if index + 1 == len(args):
                raise SystemExit(f"{flag} has no value")
            pairs.append((flag, args[index + 1]))
            index += 2
        else:
            index += 1

    plugin_dirs = [Path(value) for flag, value in pairs if flag == "--plugin-dir"]
    skill_plugins = [
        plugin_dir
        for plugin_dir in plugin_dirs
        if (plugin_dir / ".claude-plugin" / "plugin.json").is_file()
        and json.loads((plugin_dir / ".claude-plugin" / "plugin.json").read_text())["name"]
        == "den-skills"
    ]
    if len(skill_plugins) != 1:
        raise SystemExit(f"expected one den-skills plugin, found {skill_plugins}")

    skills = skill_plugins[0] / "skills"
    expected_skills = {
        "commit",
        "frontend-design",
        "github",
        "module-size",
        "nix-config",
        "codebase-design",
        "domain-modeling",
        "simple-english",
        "using-superpowers",
        "test-driven-development",
        "writing-plans",
        "ctx-search",
        "context-mode",
    }
    forbidden_skills = {
        "gitea",
        "linear",
        "notion",
        "show-me",
        "subagent-model-profiles",
        "intervals-time-entries",
        "agent-network",
        "pi-subagents",
    }
    actual_skills = {entry.name for entry in skills.iterdir() if entry.is_dir()}
    missing_skills = expected_skills - actual_skills
    unexpected_forbidden_skills = forbidden_skills & actual_skills
    if missing_skills:
        raise SystemExit(f"missing skills: {sorted(missing_skills)}")
    if unexpected_forbidden_skills:
        raise SystemExit(f"forbidden skills: {sorted(unexpected_forbidden_skills)}")

    mcp_configs = [Path(value) for flag, value in pairs if flag == "--mcp-config"]
    if len(mcp_configs) != 1:
        raise SystemExit(f"expected one MCP config, found {mcp_configs}")
    mcp_config = json.loads(mcp_configs[0].read_text())
    if mcp_config["mcpServers"]["context-mode"]["command"] != context_mode_command:
        raise SystemExit("Context Mode command differs from the bundle declaration")
    PY
    ${pkgs.python3}/bin/python "$TMPDIR/check-resources.py"

    mkdir -m 0700 -p "$TMPDIR/home" "$TMPDIR/claude"
    printf '%s\n' \
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"den-bundle-check","version":"1"}}}' \
      | env -i HOME="$TMPDIR/home" CLAUDE_CONFIG_DIR="$TMPDIR/claude" \
          "$contextModeCommand" > "$TMPDIR/context-mode.out"
    grep -Fq '"id":1' "$TMPDIR/context-mode.out"
    test -d "$TMPDIR/claude/context-mode/sessions"
    test ! -e "$TMPDIR/home/.pi/context-mode"

    touch "$out"
  ''
