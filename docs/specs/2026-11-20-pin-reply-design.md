# Pin a reply — design

## Intent

Keep one agent reply at hand while the conversation moves on. The user pins a
reply (for example a status summary with next steps), opens it whenever they
want to check it, and releases it when done. It works like a bookmark for one
message.

## Goals

- `/pin` saves the last assistant reply into a single slot. Pinning again
  replaces the slot.
- `/pinned` or `ctrl+alt+p` opens the pinned reply in a floating viewer over
  the conversation. It renders as markdown and scrolls. `Esc` (or `q`) closes it.
- `/unpin` empties the slot.
- A small `📌` marker in the footer shows that something is pinned.
- The pin survives `/reload`, compaction and session resume.

## Non-goals

- More than one slot (may come later).
- Checkboxes, strikethrough or progress tracking.
- A tool for the agent. The pin is for the user only.

## Anti-goals

- The pin must never reach the model's context or use tokens.
- The viewer must not take screen space while it is closed.

## Approaches

- **A. Floating viewer (picked).** Uses `ctx.ui.custom(..., { overlay: true })`.
  It handles long replies and stays out of the way until opened.
- B. A panel above the editor that stays on screen, with a toggle. Rejected
  because long replies would push the conversation off screen or get cut.
- C. Reprint the reply into the chat. Rejected because it clutters the
  transcript and scrolls away again.

The user picked A.

## How it works

- **Storage:** `pi.appendEntry("pin-reply", { text, pinnedAt } | { cleared: true })`.
  Custom entries are not sent to the model. On `session_start` and after tree
  navigation, the current pin is rebuilt from the latest `pin-reply` entry on
  the current branch (`getBranch()`), so branching behaves correctly.
- **Source text:** the text content of the last assistant message on the
  branch. Thinking blocks and tool calls are left out. If there is no reply
  with text, `/pin` shows a warning and changes nothing.
- **Viewer:** a markdown component inside a bordered box. It is sized to about
  80% of the terminal and has a title such as `📌 Pinned · 14:32`. ↑/↓, j/k,
  PgUp/PgDn, Home/End scroll it. A footer hint lists the keys.
- **No pin:** `/pinned` and the shortcut show "Nothing is pinned."
- **Code:** a new `extensions/pin-reply/` folder. Logic that does not depend on
  the UI (finding the last reply text, rebuilding pin state from entries) lives
  in its own module with unit tests. The viewer is checked by hand.

## Builder's calls

- The exact viewer size, colours and title format.
- Whether `/pin` shows a short preview in its confirmation message.
