---
name: claude-zellij-prompt
description: Use when requesting feedback or review from a subscription-backed interactive Claude Code session through Zellij, including prompt delivery, terminal-output capture, blocked Claude UI, timeouts, and temporary-session cleanup.
---

# Claude Zellij Prompt

Use interactive `claude` in an ephemeral Zellij pane. Preserve the prompt; the caller's sandbox and configuration govern tools and permissions.

## Preconditions

- Run from the sandboxed repository Claude should inspect.
- Require `claude`, `jq`, GNU `timeout`, and Zellij whose `zellij action list-panes --help` documents `--json`. Do not invoke `list-panes --json` before the session exists.
- Never use `claude --print`, API credentials, `--dangerously-skip-permissions`, or tool restrictions.

## Session Contract

Use a collision-resistant name, a private temporary Zellij socket directory, and unconditional cleanup. Identify a ready focused shell pane, then type the static `claude` command there.

```bash
set -euo pipefail
temp_dir="$(mktemp -d)"
session="pi-claude-feedback-$(date +%s)-$RANDOM"
timeout_seconds="${CLAUDE_ZELLIJ_TIMEOUT_SECONDS:-600}"
deadline=$((SECONDS + timeout_seconds))
export ZELLIJ_SOCKET_DIR="$temp_dir/zellij"
export ZELLIJ_SOCK_DIR="$ZELLIJ_SOCKET_DIR"
cleanup() {
  zellij delete-session --force "$session" >/dev/null 2>&1 || true
  rm -rf "$temp_dir"
}
trap cleanup EXIT INT TERM HUP
mkdir -p "$ZELLIJ_SOCKET_DIR"

zellij attach --create-background "$session"
while :; do
  remaining=$((deadline - SECONDS))
  if ((remaining <= 0)); then
    printf 'TIMEOUT session=%s phase=pane-discovery\n' "$session" >&2
    exit 124
  fi
  pane=$(
    ZELLIJ_SESSION_NAME="$session" timeout "${remaining}s" zellij action list-panes --json 2>/dev/null |
      jq -r 'map(select(.is_plugin == false and .is_focused == true)) | first | .id // empty'
  ) || true
  if ((SECONDS >= deadline)); then
    printf 'TIMEOUT session=%s phase=pane-discovery\n' "$session" >&2
    exit 124
  fi
  test -n "$pane" && break
  sleep 0.2
done
ZELLIJ_SESSION_NAME="$session" zellij action write-chars --pane-id "$pane" claude
ZELLIJ_SESSION_NAME="$session" zellij action send-keys --pane-id "$pane" Enter
```

Launching static `claude` and submitting Enter are required before prompt polling. Set `CLAUDE_ZELLIJ_TIMEOUT_SECONDS` from the caller's deadline when it differs from 600 seconds, and use the same `$deadline` while polling `ZELLIJ_SESSION_NAME="$session" zellij action dump-screen --full --pane-id "$pane"` until Claude visibly reaches its prompt. Inspect the UI—never hardcode a prompt glyph/regex. Keep every capture under `$temp_dir`, outside the repository, so the same trap removes sockets and captures. Poll intervals are acceptable; fixed sleeps do not prove readiness.

## Deliver and Capture the Prompt

After the interactive prompt is visible, paste the prompt as data and submit it. Quote it; never shell-evaluate it or add instructions.

```bash
ZELLIJ_SESSION_NAME="$session" zellij action paste --pane-id "$pane" "$prompt"
ZELLIJ_SESSION_NAME="$session" zellij action send-keys --pane-id "$pane" Enter
```

Continue polling full scrollback. Complete only after visible feedback and idle input; return the final full capture.

## Blocked States

If the capture shows a permission dialog, user question, authentication failure, or other input-needed UI, stop. Do not respond, auto-approve, bypass permissions, or mutate the prompt. Return the full capture as blocked, then clean up.

On deadline expiry, report the session name, timeout, and latest capture; cleanup still runs.

## Quick Reference

| Need | Command |
| --- | --- |
| Isolate temporary server | Set `ZELLIJ_SOCKET_DIR` and `ZELLIJ_SOCK_DIR` under `$temp_dir` |
| Bound every wait | Set one `$deadline`, wrap each external poll with `timeout`, and recheck before accepting success |
| Start temporary session | `zellij attach --create-background "$session"` |
| Start interactive Claude | `zellij action write-chars ... claude`, then Enter |
| Send arbitrary multiline prompt | `zellij ... action paste --pane-id "$pane" "$prompt"` |
| Submit | `zellij ... action send-keys --pane-id "$pane" Enter` |
| Capture response | `zellij ... action dump-screen --full --pane-id "$pane"` |
| Always remove session | `zellij delete-session --force "$session"` |

## Common Mistakes and Rationalizations

| Shortcut | Required behavior |
| --- | --- |
| “Print mode is faster.” | Use interactive Claude in its pane. |
| “The default Zellij socket is simpler.” | Use the private socket directory; never expose unrelated sessions. |
| “Checking time between polls is enough.” | Bound each Zellij call with its remaining budget and recheck before accepting a pane. |
| “A created session means Claude is ready.” | Type static `claude`, submit Enter, then poll for its visible prompt. |
| “A fixed name or repo capture is simpler.” | Use a unique name and temporary capture. |
| “Shell-building prompts or approval is safe.” | Use quoted `paste`; never respond. |

## Red Flags

Stop before print mode, prompt changes, approval keystrokes, shell evaluation, or session leaks.
