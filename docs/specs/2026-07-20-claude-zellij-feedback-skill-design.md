# Claude Zellij Feedback Skill Design

## Purpose

Provide a repository Pi skill that asks a subscription-backed, interactive Claude Code session for feedback. Each invocation creates an isolated Zellij session in the current sandboxed repository, sends the supplied prompt unchanged, captures Claude's response, and removes all session state.

## Scope

- Install the skill at `skills/claude-zellij-prompt/` so the repository's packaged Pi resources make it reusable across repositories.
- Drive the ordinary interactive `claude` TUI inside a detached Zellij session.
- Use the caller's current working directory, which the user will sandbox and configure with normal Claude permissions for repository Read and Bash access.
- Capture the complete terminal scrollback and return Claude's response to the invoking agent.

Out of scope: `claude --print`, API-key invocation, prompt rewriting, tool restrictions, permission bypasses, automatic permission approvals, persistent sessions, and changes to Claude or sandbox configuration.

## Lifecycle

1. Verify that `claude` and `zellij` are available, and generate a collision-resistant session name.
2. Create a detached Zellij session in the current repository, use `list-panes --json` to wait for and identify its focused terminal pane, then type normal interactive `claude` there.
3. Wait for Claude's interactive input prompt.
4. Paste the caller's prompt verbatim, submit it, and poll Zellij's full pane scrollback.
5. Detect that Claude has returned to its input prompt after producing output. Capture the full scrollback as feedback.
6. On timeout, permission prompt, question requiring human input, or other incomplete state, return the captured screen as diagnostic evidence rather than guessing or approving anything.
7. In every exit path, force-delete the named Zellij session. Temporary local artifacts, if used, must also be removed.

## Safety and Error Handling

The skill uses normal Claude Code permission handling. It does not set `--dangerously-skip-permissions`, send affirmative responses to permission dialogs, or append instructions such as "do not use tools". Prompts are sent as data through Zellij actions, never interpolated into shell commands. A timeout must include the final full screen capture and session name; cleanup still runs.

## Validation

Skill-authoring validation will first establish a no-skill baseline with fresh subagents, then verify that agents following the skill use the interactive UI, preserve prompts, correctly capture feedback, report blocked states, and clean up sessions. Direct local checks will validate the Zellij and Claude command syntax and confirm that no named Zellij session remains after a controlled run.
