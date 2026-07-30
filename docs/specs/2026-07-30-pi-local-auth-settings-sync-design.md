# pi-local-auth Settings Synchronization and Auth Status Design

## Status

Approved for implementation.

## Problem

`pi-local-auth` currently generates `.pi/local-agent/settings.json` only when the file does not already exist. The packaged command also forces `PI_LOCAL_AUTH_SETTINGS_TEMPLATE` to the Nix-provided `pi-config/settings.json`.

That template is not the effective user configuration. Home Manager applies host-specific `programs.roche-pi.settings` overrides after building `pi-config`, and Pi may persist additional runtime settings in `~/.pi/agent/settings.json`. A project-local file generated from the package template therefore omits effective global settings and becomes stale after later global changes. Refusing to update an existing local file preserves that drift.

The project-local agent directory exists only to give the project its own `auth.json`. The effective global settings remain the source of truth.

Local-auth and global-auth Pi sessions otherwise look the same in the TUI, so users also lack a persistent indication of which agent-directory mode is active. That makes it easy to authenticate or work in the wrong scope without noticing.

## Goals

- Treat `~/.pi/agent/settings.json` as the canonical settings source.
- Reconcile `.pi/local-agent/settings.json` every time `pi-local-auth` runs.
- Preserve all effective global settings while adding the routing required after overriding `PI_CODING_AGENT_DIR`.
- Keep project-specific authentication under `.pi/local-agent/auth.json` untouched.
- Continue sharing global sessions and global Pi resources.
- Preserve the existing idempotent `.envrc` behavior.
- Fail without damaging an existing local configuration when the global settings cannot be used.
- Show the active local or global authentication mode in Pi's built-in status line using distinct theme colors.

## Non-goals

- Modifying Pi upstream or adding an auth-file environment variable.
- Supporting repository-specific settings overrides.
- Keeping settings synchronized continuously without rerunning `pi-local-auth`.
- Synchronizing Pi runtime files such as trust, run history, model caches, or crash logs.
- Adding or managing resource symlinks.
- Moving or migrating authentication contents.
- Inspecting `auth.json`, following auth-file symlinks, or verifying which credentials Pi ultimately resolves.
- Replacing or otherwise customizing Pi's built-in footer.

## Effective Settings Contract

The generated local settings are the effective global settings merged with these top-level routing overrides:

```json
{
  "sessionDir": "~/.pi/agent/sessions",
  "extensions": ["~/.pi/agent/extensions"],
  "skills": ["~/.pi/agent/skills"],
  "prompts": ["~/.pi/agent/prompts"],
  "themes": ["~/.pi/agent/themes"]
}
```

All other global values, including nested objects, package paths, model selection, voice configuration, theme selection, and extension-specific settings, are preserved.

The routing values intentionally override any same-named global values. Once `.envrc` sets `PI_CODING_AGENT_DIR` to `.pi/local-agent`, Pi would otherwise resolve configuration and resource discovery relative to the local agent directory. The explicit paths restore global resources. `PI_CODING_AGENT_SESSION_DIR` has higher precedence than `sessionDir`, but retaining `sessionDir` keeps the generated settings correct when Pi starts without direnv loaded.

## Reconciliation Flow

When run from a project directory, `pi-local-auth` will:

1. Resolve the global source as `$HOME/.pi/agent/settings.json`.
2. Require the source to exist, be readable, and contain exactly one strict RFC 8259 JSON object; empty input, multiple JSON documents, malformed or non-standard numeric syntax such as `NaN`, `Infinity`, `+1`, `01`, and `.5`, arrays, and scalar values are invalid.
3. Reject an existing symlink at `.pi` or `.pi/local-agent`, create `.pi/local-agent/` when needed, and verify its physical path is the expected directory inside the current project before writing temporary files.
4. Copy the source bytes to a temporary snapshot inside `.pi/local-agent/`, validate that exact snapshot with Python's strict JSON parser in isolated mode (`python3 -I`), then use `jq` to merge the five routing overrides from the validated snapshot into a separate temporary output file.
5. Atomically rename the completed temporary file to `.pi/local-agent/settings.json`.
6. Ensure `.envrc` exists.
7. Append the existing `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` exports only when each variable is absent.

The command performs settings reconciliation on every run. An existing local settings regular file or symlink, including a symlink to a directory, is managed output and is replaced. An existing directory at the settings path is rejected without modifying `.envrc`. No backup is created because repository-specific settings are unsupported and the global file is authoritative.

The command does not read, write, remove, or relink `.pi/local-agent/auth.json`. Other Pi-created files under the local agent directory are also left untouched.

## Authentication Scope Status

Add a dedicated global extension at `extensions/auth-scope/index.ts`, with focused tests colocated at `extensions/auth-scope/index.test.ts`. The directory entry-point pattern prevents Pi from auto-discovering the test module as an extension. The extension reports the authentication mode implied by Pi's effective agent directory; it does not inspect authentication contents or resolve auth-file symlinks.

On every `session_start` event with UI available, the extension will:

1. Resolve the global agent directory as `~/.pi/agent` using the process home directory.
2. Read `PI_CODING_AGENT_DIR` from the process environment.
3. Expand a leading `~` and normalize relative and absolute paths before comparison.
4. Classify an unset, empty, or globally resolved value as `GLOBAL`.
5. Classify any other resolved agent directory as `LOCAL`.
6. Publish one persistent built-in footer entry with `ctx.ui.setStatus("auth-scope", ...)`:
   - `auth: LOCAL` using the theme's `success` foreground color;
   - `auth: GLOBAL` using the theme's `warning` foreground color.

The extension uses semantic theme colors rather than hard-coded ANSI values, so both labels remain compatible with the active Pi theme. It does nothing in non-UI modes, does not reveal the selected path, and does not replace the built-in footer.

## Failure Handling

Settings generation completes successfully before `.envrc` is changed.

If the global settings file is missing, unreadable, empty, malformed, contains non-standard numeric tokens, contains multiple JSON documents, or does not contain exactly one object, if the local agent path is symlinked or resolves outside the project, or if snapshot creation, temporary-file creation, or the atomic rename fails, the command will:

- exit nonzero with an actionable error;
- leave the previous `.pi/local-agent/settings.json` unchanged;
- leave `.envrc` unchanged; and
- remove any temporary file it created.

The previous minimal fallback settings are removed. Generating fallback settings would violate the requirement that the effective global settings are authoritative and could silently disable configured packages or user overrides.

## Nix Integration

`modules/packages/pi-local-auth.nix` will stop exporting `PI_LOCAL_AUTH_SETTINGS_TEMPLATE` from `self'.packages.pi-config`. The runtime command will always resolve the effective global settings from the invoking user's home directory.

The package retains the runtime tools required by the shell implementation, including `jq`, `python3`, `coreutils`, and `gnugrep`. Python runs in isolated mode so project-local modules cannot shadow the standard-library `json` parser; it validates the exact source snapshot with strict JSON semantics before `jq` performs the merge.

The Nix check will create a temporary `HOME` containing a representative `.pi/agent/settings.json` fixture. This verifies runtime behavior without coupling the command to a build-time settings template.

`pi-config` already packages the repository's `extensions/` directory, so `extensions/auth-scope/index.ts` requires no separate resource-wiring mechanism. The packaged extension-load check must cover the new extension and prove that its colocated test file is not loaded at runtime.

## Testing

The settings merge, failure behavior, and authentication-mode classification are reusable production behavior and warrant automated regression coverage.

The focused `pi-local-auth` Nix check will prove that:

1. Representative scalar, array, and nested global settings are preserved.
2. The five routing values override conflicting global values.
3. An existing stale local settings file is refreshed on rerun.
4. A later change to the global fixture propagates on the next run.
5. An existing local `auth.json` remains byte-for-byte unchanged.
6. Malformed, empty, multi-document, non-object, and non-RFC numeric forms (`NaN`, `Infinity`, `+1`, `01`, and `.5`) return nonzero and leave existing local settings and `.envrc` unchanged.
7. A missing global settings file returns nonzero and leaves existing local settings and `.envrc` unchanged.
8. An existing directory at `.pi/local-agent/settings.json` is rejected without changing `.envrc`.
9. A symlink-to-directory at `.pi/local-agent/settings.json` is replaced by the generated regular file without modifying the target directory.
10. A project-local `json.py` cannot be imported by strict validation.
11. Symlinked `.pi` and `.pi/local-agent` parents are rejected without changing global settings or `.envrc`.
12. Repeated successful runs remain idempotent and do not duplicate `.envrc` exports.
13. Existing custom `.envrc` assignments remain preserved under the current variable-detection rules.

Focused extension tests will prove that:

1. An unset, empty, absolute-global, or tilde-global agent directory classifies as `GLOBAL`.
2. A normalized non-global agent directory classifies as `LOCAL`.
3. UI sessions publish `auth: LOCAL` with `success` and `auth: GLOBAL` with `warning` under the `auth-scope` status key.
4. Non-UI sessions do not publish a status.

Implementation verification will run:

```sh
nix build .#checks.x86_64-linux.pi-local-auth --no-link
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
```

## Compatibility and Migration

Existing projects can adopt the new behavior by rerunning `pi-local-auth`. The command replaces stale local settings with the effective global configuration plus the required routing overrides while preserving project authentication and other local runtime state.

Users must rerun `pi-local-auth` after changing global settings. Continuous synchronization is intentionally out of scope.

The auth-scope indicator is packaged with the global extensions. After the updated Pi configuration is activated, it appears in global sessions and in local-agent sessions that load the configured global extensions; no project-specific extension installation is required.
