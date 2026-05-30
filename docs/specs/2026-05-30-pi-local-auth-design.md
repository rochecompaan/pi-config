# pi-local-auth Design

## Goal

Add a Nix-provided `pi-local-auth` executable to bootstrap any repository for repo-local Pi authentication while keeping sessions and user resources global.

The command is intended for the Nix-only audience of `roche-pi` and should be available from the flake/dev shell rather than as the primary checked-in standalone script interface.

## Behavior

When run from a repository root or project directory, `pi-local-auth` will:

1. Create `.pi/local-agent/` if needed.
2. Create `.pi/local-agent/settings.json` if it does not exist.
3. Ensure `.envrc` exists.
4. Append missing exports for:
   - `PI_CODING_AGENT_DIR="$PWD/.pi/local-agent"`
   - `PI_CODING_AGENT_SESSION_DIR="$HOME/.pi/agent/sessions"`
5. Leave existing `.envrc` lines untouched if either variable is already present, even if the value differs.

## Bootstrap Settings

The generated `.pi/local-agent/settings.json` should restore global resource discovery that would otherwise be lost when `PI_CODING_AGENT_DIR` points at `.pi/local-agent`:

```json
{
  "sessionDir": "~/.pi/agent/sessions",
  "extensions": ["~/.pi/agent/extensions"],
  "skills": ["~/.pi/agent/skills"],
  "prompts": ["~/.pi/agent/prompts"],
  "themes": ["~/.pi/agent/themes"]
}
```

Only include `~/.pi/agent/skills` for global skills.

Do not include project-local `.pi/skills`, `.pi/extensions`, or `.agents/skills` in the generated settings. Pi already auto-discovers those from the current project, and listing them in the local-agent settings would be redundant.

## Existing File Handling

- If `.pi/local-agent/settings.json` already exists, leave it unchanged. This avoids overwriting user edits or tokens-adjacent configuration.
- If `.envrc` exists, append only missing exports.
- If `.envrc` does not exist, create it with the two exports.
- If either variable name already appears in `.envrc`, leave that variable as-is.

## Nix Integration

Expose `pi-local-auth` as a package/app or dev-shell executable using `pkgs.writeShellApplication` or the existing flake module pattern. Add it to the default dev shell packages so it is available in normal `nix develop` sessions.

## Testing

Add lightweight verification for the generated executable by running it in temporary directories and checking:

- it creates `.pi/local-agent/settings.json` with the expected JSON;
- it creates `.envrc` when absent;
- it appends missing variables to an existing `.envrc`;
- it preserves existing variable lines with different values;
- repeated runs are idempotent.
