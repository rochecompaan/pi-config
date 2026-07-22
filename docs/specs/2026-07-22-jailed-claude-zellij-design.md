# Jailed Claude/Zellij Integration Design

## Goal

Allow the packaged `claude-zellij-prompt` skill to launch subscription-authenticated interactive Claude Code from jailed Pi while keeping Claude inside Pi's existing bubblewrap sandbox.

## Architecture

Do not create a separate `jailed-claude` wrapper. Claude is already jailed when the skill launches the ordinary `claude` command as a child of jailed Pi. Extend `modules/home/jailed-pi.nix` with the packages, shared state, and terminal environment required by that child process.

Update the skill to keep each temporary Zellij server socket under its cleanup-managed temporary directory. This prevents the skill from using or exposing unrelated host Zellij sessions.

## Packages

Add these packages to jailed Pi's runtime in addition to existing and user-supplied packages:

- `inputs.llm-agents.packages.${pkgs.system}."claude-code"` for the repository-pinned Claude Code CLI;
- Zellij from `inputs.llm-agents.inputs.nixpkgs`, currently version 0.44.3.

Do not use the repository's current `pkgs.zellij` 0.43.1 because it lacks `zellij action list-panes --json`, which the skill requires. `jq` is already part of `mkJailedPi`'s common package set.

## Shared Claude state

Expose the user's existing Claude state read-write so jailed Claude uses the same subscription authentication, settings, and runtime state as ordinary Claude Code:

- `~/.claude`;
- `~/.claude.json`;
- `~/.config/claude`.

Use optional bind combinators so jailed Pi still starts on hosts where one or more paths do not exist. Do not expose the rest of the home or `~/.config`.

This intentionally allows Pi and Claude processes inside the jail to access the Claude subscription credentials and state. That capability is required for the requested interaction model.

## Terminal and Zellij behavior

Forward `TERM` into jailed Pi. The jail otherwise clears it, causing a detached Zellij pane to receive `TERM=dumb`; forwarding the caller's `xterm-256color` gives Claude a TUI-capable terminal description.

The skill must:

1. create its existing cleanup-managed temporary directory before starting Zellij;
2. set both `ZELLIJ_SOCKET_DIR` and `ZELLIJ_SOCK_DIR` to a private subdirectory there for compatibility;
3. use its existing collision-resistant session name and unconditional `delete-session` cleanup;
4. continue using interactive `claude`, verbatim prompt paste, observable UI readiness/completion, and blocked-state reporting.

The private socket directory must remain outside the repository and be removed by the same cleanup path as captures.

## Scope

Modify production behavior only in:

- `modules/home/jailed-pi.nix`;
- `skills/claude-zellij-prompt/SKILL.md`.

No new `mkJailedPi` public interface, standalone Claude wrapper, host Zellij socket bind, API-key mode, `claude --print`, or permission bypass is included.

## Verification

This change combines static Nix configuration and process-guidance documentation. Do not add tests that assert file text. Verify behavior directly:

1. format and evaluate the Home Manager module;
2. build a synthetic jailed Pi package;
3. confirm the closure contains Claude Code and Zellij 0.44.3 or newer;
4. run `claude --version`, `zellij --version`, and `jq --version` inside the jail;
5. verify the three Claude state paths are visible inside the jail when present;
6. create, discover with `list-panes --json`, inspect, and delete a harmless private Zellij session inside the jail;
7. confirm the Zellij pane receives a non-`dumb` `TERM`;
8. run skill pressure checks for private socket setup, prompt preservation, blocked-state behavior, and cleanup;
9. run `nix flake check --accept-flake-config --print-build-logs`.

Do not perform a live Claude prompt, modify authentication, or activate Home Manager during automated verification.
