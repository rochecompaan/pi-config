{ pkgs, claude, bundle, piConfig, piDeps }:

assert bundle.denResources.pi ? packages;
assert bundle.denResources.claude ? skills;
assert bundle.denResources.claude.mcpServers ? context-mode;
let
  # The design names these skills one by one. Every skill in the Superpowers
  # and Context Mode skill directories is also included.
  namedSkills =
    pkgs.lib.genAttrs
      [ "commit" "frontend-design" "github" "module-size" "nix-config" "simple-english" ]
      (name: "${piConfig}/skills/${name}")
    // pkgs.lib.genAttrs
      [ "codebase-design" "domain-modeling" ]
      (name: "${piDeps.mattPocockSkills}/skills/engineering/${name}");
  skillDirectories = [
    "${piDeps.superpowersSrc}/skills"
    "${piDeps.contextMode}/lib/node_modules/context-mode/skills"
  ];
in
pkgs.runCommand "den-bundle-claude"
  {
    nativeBuildInputs = [ pkgs.coreutils pkgs.gnugrep pkgs.jq pkgs.python3 ];
    claudeManifest = claude.denManifest;
    contextModeCommand = bundle.denResources.claude.mcpServers.context-mode.command;
    namedSkills = builtins.toJSON namedSkills;
    skillDirectories = builtins.toJSON skillDirectories;
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
    expected_skills = json.loads(os.environ["namedSkills"])
    for directory in json.loads(os.environ["skillDirectories"]):
        for entry in Path(directory).iterdir():
            if not entry.is_dir():
                continue
            if entry.name in expected_skills:
                raise SystemExit(f"two sources provide skill {entry.name}")
            expected_skills[entry.name] = str(entry)
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
    actual_skills = {entry.name: entry for entry in skills.iterdir()}
    missing_skills = expected_skills.keys() - actual_skills.keys()
    extra_skills = actual_skills.keys() - expected_skills.keys()
    unexpected_forbidden_skills = forbidden_skills & actual_skills.keys()
    if missing_skills:
        raise SystemExit(f"missing skills: {sorted(missing_skills)}")
    if extra_skills:
        raise SystemExit(f"unexpected skills: {sorted(extra_skills)}")
    if unexpected_forbidden_skills:
        raise SystemExit(f"forbidden skills: {sorted(unexpected_forbidden_skills)}")
    for name, entry in actual_skills.items():
        if entry.resolve() != Path(expected_skills[name]).resolve():
            raise SystemExit(f"skill {name} comes from {entry.resolve()}, not {expected_skills[name]}")

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
