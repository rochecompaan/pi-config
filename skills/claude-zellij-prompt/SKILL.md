---
name: claude-zellij-prompt
description: Use when requesting feedback or review from a subscription-backed interactive Claude Code session through Zellij, including prompt delivery, terminal-output capture, blocked Claude UI, timeouts, and temporary-session cleanup.
---

# Claude Zellij Prompt

Use interactive `claude` in an ephemeral Zellij pane. Preserve the prompt; the caller's sandbox and configuration govern tools and permissions.

## Preconditions

- Run from the sandboxed repository Claude should inspect.
- Require `claude`, `zellij`, and `jq` before session creation.
- Never use `claude --print`, API credentials, `--dangerously-skip-permissions`, or tool restrictions.

## Session Contract

Use a collision-resistant name and unconditional cleanup. Identify a ready focused shell pane, then type the static `claude` command there.

```bash
set -euo pipefail
session="pi-claude-feedback-$(date +%s)-$RANDOM"
cleanup() { zellij delete-session --force "$session" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

zellij attach --create-background "$session"
until pane=$(ZELLIJ_SESSION_NAME="$session" zellij action list-panes --json 2>/dev/null | jq -r 'map(select(.is_plugin == false and .is_focused == true)) | first | .id // empty') && test -n "$pane"; do sleep 0.2; done
ZELLIJ_SESSION_NAME="$session" zellij action write-chars --pane-id "$pane" claude
ZELLIJ_SESSION_NAME="$session" zellij action send-keys --pane-id "$pane" Enter
```

Use caller deadline while polling `ZELLIJ_SESSION_NAME="$session" zellij action dump-screen --full --pane-id "$pane"` until Claude visibly reaches its prompt. Inspect the UI—never hardcode a prompt glyph/regex. Keep captures outside the repository in a cleanup-managed temporary directory. Poll intervals are acceptable; fixed sleeps do not prove readiness.

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
| “A fixed name or repo capture is simpler.” | Use a unique name and temporary capture. |
| “Shell-building prompts or approval is safe.” | Use quoted `paste`; never respond. |

## Red Flags

Stop before print mode, prompt changes, approval keystrokes, shell evaluation, or session leaks.
