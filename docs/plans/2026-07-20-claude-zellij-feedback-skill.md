# Claude Zellij Feedback Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install a repository skill that obtains feedback from normal interactive Claude Code sessions driven through ephemeral Zellij sessions.

**Architecture:** The skill is a self-contained process guide in the repository's packaged `skills/` resources. It creates one detached Zellij session in the caller's sandboxed repository, sends the caller's prompt verbatim to normal interactive `claude`, polls full scrollback for completion or a blocked state, returns the capture, and force-deletes the session in every exit path.

**Tech Stack:** Pi skills Markdown, Claude Code interactive TUI, Zellij 0.44+ CLI, Bash, `jq`.

## Global Constraints

- Use interactive `claude`; never use `claude --print` or API credentials.
- Do not alter the caller's prompt, disable tools, bypass permissions, or approve prompts.
- Rely on the user-provided sandbox and Claude configuration for normal Read/Bash authorization.
- Every session name must be unique and every path must clean it up with `zellij delete-session --force`.
- Do not add an automated test: this is personal process documentation. Verify by delegated pressure scenarios and direct command checks instead.

---

### Task 1: Establish the no-skill baseline

**Files:**
- Create: none
- Modify: none
- Test: fresh-context subagent transcripts

**Interfaces:**
- Consumes: the approved design spec at `docs/specs/2026-07-20-claude-zellij-feedback-skill-design.md`
- Produces: a concise record of unsafe or incomplete default approaches the skill must prevent.

- [ ] **Step 1: Create three pressure scenarios**

Use the same concrete requirement in each scenario: “Obtain a code-review response from subscription-backed interactive Claude Code in a temporary Zellij session; preserve the prompt, let Claude use its sandboxed Read/Bash tools, capture feedback, then remove the session.” Add a distinct pressure: finish quickly, a multiline/untrusted prompt, and an unresolved permission/question UI.

- [ ] **Step 2: Run fresh baseline delegates without the new skill**

Run `delegate` with `context: "fresh"` once per scenario. Do not inject a skill. Require each to return the exact command sequence it would use and cleanup/error behavior.

Expected: at least one baseline chooses `claude --print`, changes the prompt, uses a fixed session name, treats a screen dump as a completed answer without checking the TUI state, or auto-approves a prompt.

- [ ] **Step 3: Record the observed failure modes**

Save the actual choices and rationalizations in the task record. These observations, not hypothetical risks, determine the skill's prohibitions and output recipe.

### Task 2: Write the personal interactive-session skill

**Files:**
- Create: `skills/claude-zellij-prompt/SKILL.md`
- Modify: none
- Test: command help and controlled Zellij lifecycle checks

**Interfaces:**
- Consumes: the approved spec and Task 1 baseline failures.
- Produces: the discoverable `claude-zellij-prompt` skill.

- [ ] **Step 1: Write frontmatter and triggering conditions**

Create the file with this frontmatter:

```markdown
---
name: claude-zellij-prompt
description: Use when requesting feedback or review from a subscription-backed interactive Claude Code session through Zellij, including prompt delivery, terminal-output capture, timeouts, and temporary-session cleanup.
---
```

- [ ] **Step 2: Add the required lifecycle contract**

Specify these required operations in order: verify `claude`, `zellij`, and `jq`; create `session="pi-claude-feedback-$(date +%s)-$RANDOM"`; install an `EXIT` cleanup trap that runs `zellij delete-session --force "$session"`; start a detached session with `zellij attach --create-background "$session"`; target it with `ZELLIJ_SESSION_NAME="$session"`, then wait for `list-panes --json` to report a focused non-plugin terminal pane using `jq`; type static `claude` with `write-chars` into that pane and send Enter; wait for the normal interactive prompt; paste the caller prompt verbatim and submit Enter; poll `ZELLIJ_SESSION_NAME="$session" zellij action dump-screen --full --pane-id "$pane"`; return the full capture only after Claude is visibly idle at its input prompt.

- [ ] **Step 3: Add the safety recipe and blocked-state behavior**

State that prompt text is passed only as an action argument, never embedded in a shell command. State that Claude runs normally: no `--print`, no `--dangerously-skip-permissions`, no automatic acceptance, and no extra instruction added to the prompt. If the screen indicates a permission request, a question requiring the user, or lacks stable idle input before timeout, return the full capture as a blocked diagnostic and still clean up.

- [ ] **Step 4: Include one runnable lifecycle example**

Include this Bash skeleton; pass the caller prompt only as the quoted `paste` argument:

```bash
set -euo pipefail
session="pi-claude-feedback-$(date +%s)-$RANDOM"
cleanup() { zellij delete-session --force "$session" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
zellij attach --create-background "$session"
until pane=$(ZELLIJ_SESSION_NAME="$session" zellij action list-panes --json 2>/dev/null | jq -r 'map(select(.is_plugin == false and .is_focused == true)) | first | .id // empty') && test -n "$pane"; do sleep 0.2; done
ZELLIJ_SESSION_NAME="$session" zellij action write-chars --pane-id "$pane" claude
ZELLIJ_SESSION_NAME="$session" zellij action send-keys --pane-id "$pane" Enter
# Wait for Claude's interactive prompt, then paste the caller prompt unchanged.
ZELLIJ_SESSION_NAME="$session" zellij action paste --pane-id "$pane" "$prompt"
ZELLIJ_SESSION_NAME="$session" zellij action send-keys --pane-id "$pane" Enter
# Poll dump-screen --full until Claude is visibly idle.
```

- [ ] **Step 5: Add quick reference and common mistakes**

Cover session creation, pane discovery, character/paste injection, full-scrollback capture, normal-permission blocked state, and force deletion. Explicitly reject fixed session names, `--print`, shell-evaluating prompts, arbitrary sleeps as completion, and leaving a session alive on failure.

### Task 3: Validate the skill and refine it

**Files:**
- Modify: `skills/claude-zellij-prompt/SKILL.md`
- Test: fresh-context subagents and direct Zellij lifecycle test

**Interfaces:**
- Consumes: Task 1 baseline record and the installed skill.
- Produces: evidence that agents follow the interactive, prompt-preserving, cleanup-safe protocol.

- [ ] **Step 1: Verify command interfaces without invoking Claude**

Run:

```sh
zellij attach --help
zellij action list-panes --help
zellij action write-chars --help
zellij action paste --help
zellij action dump-screen --help
zellij delete-session --help
```

Expected: detached creation, pane targeting, full screen dumping, and force deletion are available. Update the example only for verified command syntax.

- [ ] **Step 2: Run the same three scenarios with the skill injected**

Launch fresh `delegate` agents and inject only `claude-zellij-prompt`. Require the returned command plan to use interactive Claude, preserve the prompt, wait for observable idle completion, report blocked UI rather than approving it, and clean up by unique session name.

Expected: every delegate follows the lifecycle contract; no delegate selects print mode or permission bypass.

- [ ] **Step 3: Refine only for observed remaining gaps**

If a delegate still violates an invariant, add the smallest structural requirement or explicit prohibition that blocks that observed behavior. Repeat the affected scenario until it complies. Record any new rationalization in the skill's rationalization table and red-flags list.

- [ ] **Step 4: Perform a direct Zellij cleanup check**

Create a uniquely named harmless background session, list its terminal pane, dump the screen, then run `zellij delete-session --force "$session"`. Confirm `zellij list-sessions` does not report the name. Do not run a live Claude request during this check.

- [ ] **Step 5: Commit the plan artifacts only**

```sh
git -C /home/roche/projects/pi/roche-pi/.worktrees/claude-zellij-feedback-skill add docs/plans/2026-07-20-claude-zellij-feedback-skill.md
git -C /home/roche/projects/pi/roche-pi/.worktrees/claude-zellij-feedback-skill commit -m "docs(skills): plan Claude Zellij feedback skill"
```
