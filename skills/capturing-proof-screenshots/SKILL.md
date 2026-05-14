---
name: capturing-proof-screenshots
description: Use when a visual proof screenshot is needed for a PR, issue, QA handoff, dashboard/UI change, browser-visible bug fix, staging check, or Forgejo/Gitea review evidence.
---

# Capturing Proof Screenshots

## Overview

A proof screenshot is evidence, not decoration. Capture it from the approved running app instance, wait for the UI state that proves the change, then attach it through a verifiable channel.

## Required Pattern

1. **Verify server provenance first.** Use the project-approved readiness command (`just tilt-ready`, staging health check, deployed URL check). Do not start ad-hoc servers when project rules forbid them.
2. **Use browser automation.** Prefer Playwright. Do not use OS/window screenshots (`gnome-screenshot`, manual browser capture) for proof unless the user explicitly asks.
3. **Wait for proof conditions.** Require visible text/selectors that demonstrate the changed UI before capturing.
4. **Save to an ignored/temp path.** Use `.tmp/` or `/tmp/`; do not commit proof images unless requested.
5. **Upload/comment reproducibly.** Use `tea` for Forgejo context; when `tea` cannot upload assets, use the Forgejo issue attachment API with a token from config/env.
6. **Verify the result.** Confirm the PNG exists, the PR comment exists, and the markdown uses a real attachment URL.

## Quick Reference

| Need | Command |
| --- | --- |
| Capture | `scripts/capture-proof-screenshot.cjs --url "$URL" --output .tmp/proof.png --wait-text "Changed label"` |
| Verify Tilt first | add `--ready-command 'set -a; . ./.env; set +a; nix develop -c just tilt-ready'` |
| Authenticated app | add `--login-username admin --login-password admin` |
| Forgejo PR comment | `scripts/forgejo-comment-screenshot.sh --login git.compaan --repo owner/repo --pr 48 --file .tmp/proof.png --body 'Screenshot:\n\n![proof]({url})'` |

## Example

```bash
set -a; . ./.env; set +a
URL="http://localhost:${CROPRUN_SERVER_PORT}/dashboard"
SKILL=/home/roche/projects/agent-stuff/pi-config/skills/capturing-proof-screenshots

nix develop -c node "$SKILL/scripts/capture-proof-screenshot.cjs" \
  --ready-command 'set -a; . ./.env; set +a; nix develop -c just tilt-ready' \
  --url "$URL" \
  --output .tmp/dashboard-worker-stats.png \
  --login-username admin \
  --login-password admin \
  --wait-text 'Pickers today' \
  --wait-text 'Total trimmers today' \
  --wait-text 'Active trimmers (last 2h)'

ls -lh .tmp/dashboard-worker-stats.png

"$SKILL/scripts/forgejo-comment-screenshot.sh" \
  --login git.compaan \
  --repo roche/croprun \
  --pr 48 \
  --file .tmp/dashboard-worker-stats.png \
  --body 'Dashboard screenshot after the worker-stat label updates:\n\n![Revised dashboard worker stats]({url})'
```

## Script Notes

- `capture-proof-screenshot.cjs` uses project `@playwright/test` when available and can also load it from a Nix `playwright` wrapper.
- `forgejo-comment-screenshot.sh` reads URL/token from `~/.config/tea/config.yml` when `--login` is supplied. Keep `set +x`; never print tokens.
- If a project has an approved screenshot wrapper, use that instead of these bundled scripts.

## Common Mistakes

| Mistake | Fix |
| --- | --- |
| Screenshot from manual browser/window | Use Playwright and wait for proof text/selectors |
| Wrong/stale server instance | Run the approved readiness command immediately before capture |
| Direct test command as validation | Screenshot capture is evidence only; still run required validation separately |
| Drag/drop upload in web UI | Prefer Forgejo API upload + scripted comment |
| Broken markdown or private temp path | Verify the PR comment body contains the returned attachment URL |
| Leaving helper files tracked | Keep scripts in the skill; keep generated images under ignored `.tmp/` or `/tmp/` |

## Red Flags

Stop if you are about to write:
- “I’ll just take a quick screenshot manually.”
- “I’ll spin up a local server for the screenshot.”
- “The image looks right, so no need to verify the PR comment.”
- “I pasted a local file path into the PR.”
