# Jailed Pi Authentication Mode Design

## Status

Design approved; awaiting review of this written specification.

## Problem

The jailed Pi Home Manager activation currently always creates `~/.pi/agent/auth.json` and links the jailed agent directory's `auth.json` to it. The reusable project shell hook does the same, and the jailed wrapper exposes the global auth file inside the jail.

That behavior is correct when normal and jailed Pi should share credentials, but it conflicts with repository-local authentication created by `pi-local-auth`. A local agent directory should own its own `auth.json`; activation must not replace that file with a global symlink, and a locally authenticated jail should not receive access to the global credential.

Sessions are intentionally different. `pi-local-auth` already points sessions to `~/.pi/agent/sessions`, so sessions should remain globally shared regardless of authentication mode.

## Goals

- Make global versus agent-directory-local authentication explicit.
- Preserve current global authentication behavior by default.
- Prevent local credentials from being overwritten during activation or shell setup.
- Keep global credentials outside locally authenticated jails.
- Continue sharing `~/.pi/agent/sessions` in both modes.
- Use the same option semantics across the Home Manager module, jailed Pi builder, and project shell hook.

## Non-goals

- Making sessions local.
- Changing `pi-local-auth` or its generated session configuration.
- Supporting an arbitrary caller-supplied auth file path.
- Migrating credential contents automatically between global and local files.
- Storing credentials in Nix or the Nix store.

## Public interface

Add an authentication mode with two values:

```nix
authMode = "global"; # or "local"
```

The option is exposed consistently through:

```nix
programs.roche-pi.jailed.authMode
```

```nix
mkJailedPi {
  authMode = "global";
  # ...
}
```

```nix
projectPiShellHook {
  jailedPi = {
    enable = true;
    authMode = "global";
  };
}
```

Each interface defaults to `"global"` for backward compatibility. Nix enum typing rejects all other values during evaluation.

## Authentication semantics

| Behavior | `global` | `local` |
| --- | --- | --- |
| Create `~/.pi/agent/auth.json` when absent | Yes | No |
| Link the configured agent directory's `auth.json` to the global file | Yes | No |
| Let Pi own the resolved runtime agent directory's `auth.json` | Only for runtime overrides | Yes |
| Expose `~/.pi/agent/auth.json` inside the jail | Yes | No |
| Share `~/.pi/agent/sessions` | Yes | Yes |

`PI_CODING_AGENT_DIR` remains runtime-overridable. Activation and project-shell setup can manage only their configured agent directory; they cannot pre-create a link in an arbitrary directory selected later at runtime. In local mode, Pi reads and writes `auth.json` under the resolved runtime agent directory. In global mode, the configured/default jailed agent directory uses the global auth symlink, while a runtime override can still use its own auth file.

The mode also defines the jail's credential boundary. A wrapper built in local mode must omit the existing read-write permission for `~/.pi/agent/auth.json`; mounting only the resolved `PI_CODING_AGENT_DIR` gives Pi access to its local credentials. A global-mode wrapper continues exposing the global credential even when a runtime agent-directory override uses a local auth file. Callers requiring credential isolation must therefore select local mode. The global sessions directory remains mounted read-write in both modes.

## Activation and migration behavior

### Global mode

Home Manager activation and the project shell hook:

1. Ensure `~/.pi/agent/` and `~/.pi/agent/sessions` exist.
2. Create `~/.pi/agent/auth.json` if absent without truncating existing contents.
3. Create the expected auth symlink when `$agent_dir/auth.json` is absent.
4. Accept an existing symlink that already points to `~/.pi/agent/auth.json`.
5. Refuse to replace a regular file or unrelated symlink at `$agent_dir/auth.json`.

A conflict must fail with an actionable message naming the path and telling the user to move or remove the local credential before enabling global mode. This replaces the current destructive `ln -sfnT` behavior for auth only; immutable resource links remain unchanged.

### Local mode

Home Manager activation and the project shell hook:

1. Ensure the agent directory and global sessions directory exist.
2. Do not create the global auth file.
3. Remove `$agent_dir/auth.json` only when it is the known global-auth symlink pointing to `~/.pi/agent/auth.json`.
4. Preserve regular files and unrelated symlinks.
5. Leave an absent auth path absent so Pi can create it during local authentication.

Removing the known symlink does not delete the global credential target. Switching to local mode may therefore require the user to authenticate that agent directory the next time Pi starts.

The Home Manager activation applies migration behavior to `programs.roche-pi.jailed.agentDir`. The project shell hook applies it to `jailedPi.agentDir`. A separate runtime override such as `.pi/local-agent` remains owned by the caller and is not modified unless it is also the configured hook directory.

## Component changes

### Home Manager module

`modules/home/jailed-pi.nix` defines `programs.roche-pi.jailed.authMode` as an enum with a `"global"` default. Its activation selects the global or local auth setup while always creating and linking the shared sessions directory. It passes the selected mode to `mkJailedPi`.

### Jailed Pi builder

`modules/lib/jailed-pi.nix` accepts `authMode ? "global"`. It conditionally adds the `~/.pi/agent/auth.json` read-write permission only in global mode. The permission for the resolved `PI_CODING_AGENT_DIR` and the global sessions directory remains in both modes.

### Project shell hook

`modules/lib/project-pi.nix` adds `jailedPi.authMode`, defaulting to `"global"`, and uses the same safe auth setup and migration semantics as Home Manager activation. The sessions link remains unconditional when jailed setup is enabled.

### Repository development shell

The existing `devShells.jailed-pi` behavior remains global by default. It may set `authMode` explicitly where doing so makes the fixture's intent clearer, but no default behavior changes.

### Local-auth bootstrap

`scripts/pi-local-auth.sh` requires no behavior change. It continues to set:

```sh
PI_CODING_AGENT_DIR="$PWD/.pi/local-agent"
PI_CODING_AGENT_SESSION_DIR="$HOME/.pi/agent/sessions"
```

Users who run that directory through jailed Pi select `authMode = "local"` on the jailed wrapper/module to keep the global credential outside the jail.

## Error handling and security

- Invalid modes fail at Nix evaluation through enum typing.
- Global mode never silently deletes local credentials.
- Local mode never reads, creates, links, or mounts the global auth file.
- Local mode removes only the known global symlink and never removes its target.
- Authentication contents are not evaluated by Nix and never enter a derivation or store path.
- Sessions remain writable global state in both modes by explicit design.

## Testing

Credential handling is security-sensitive and warrants automated regression coverage. Tests should prove behavior rather than merely assert Nix source text.

Cover these scenarios in temporary homes and agent directories:

1. The default mode is global.
2. Global mode creates the missing global auth target and expected symlink.
3. Global mode preserves existing global auth contents.
4. Global mode refuses to overwrite a regular local auth file.
5. Global mode refuses to overwrite an unrelated auth symlink.
6. Local mode preserves an existing local auth file.
7. Local mode removes only the known global-auth symlink.
8. Local mode preserves an unrelated symlink.
9. Both modes retain the global sessions directory and sessions symlink.
10. A local-mode jailed wrapper cannot access the global auth file through an explicit jail mount, while a global-mode wrapper retains the mount.
11. The Home Manager module, `mkJailedPi`, and `projectPiShellHook` propagate the selected mode.

Use a focused Nix check or shell-backed derivation for filesystem behavior and wrapper execution. Do not add tests that only restate generated Nix configuration. Complete verification with:

```sh
nix flake check --accept-flake-config --print-build-logs
```

Because this is not a Pi or dependency update, the dedicated extension-load check is not required solely for this change unless implementation affects packaged Pi resources.

## Compatibility

Existing configurations remain in global mode without changes. The only tightened behavior is that global setup refuses to replace an existing non-global `auth.json`; this protects credentials that the current forced symlink would remove.

Users opting into local mode retain global sessions but authenticate independently in each effective `PI_CODING_AGENT_DIR`.
