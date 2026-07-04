# Review Findings Todo Output Design

## Goal

Add an `/end-review` option that returns from a fresh review branch, creates one aggregate todo containing the review summary and findings, and otherwise does not ask the agent to continue. This gives the user a persistent follow-up item without triggering implementation work immediately.

## User Interface

Add a fourth `/end-review` choice:

- `Return only`
- `Return and fix findings`
- `Return and summarize`
- `Return and add findings to todo`

When selected, Pi returns to the original review origin, runs the existing review-summary flow, creates one file-based todo, and shows a notification with the created `TODO-<hex>` id. No follow-up user message is sent and the editor is not prefilled.

## Todo Contents

Create a single aggregate todo, not one todo per finding.

- Title: `Review findings: <scope>` when a review scope can be extracted from the generated summary, otherwise `Review findings`.
- Status: `open`.
- Tags: `review`, `findings`.
- Body: the full generated review summary, preserving the `Review Scope`, `Verdict`, `Findings`, `Fix Queue`, `Constraints & Preferences`, and `Human Reviewer Callouts` sections exactly enough to act on later.

The todo uses the same on-disk format as `extensions/todos.ts`: JSON front matter followed by markdown body, stored under `.pi/todos` unless `PI_TODO_PATH` overrides the directory.

## Architecture

Keep `extensions/review/index.ts` focused by adding a small review-todo helper module under `extensions/review/`. The helper owns:

- resolving the todo directory from `ctx.cwd` and `PI_TODO_PATH`, matching the todo extension behavior;
- creating the todo directory if needed;
- generating an 8-hex-character todo id;
- serializing JSON front matter plus markdown body;
- deriving a concise title from the summary's `Review Scope` section when possible.

`index.ts` adds a new end-review action, calls the existing `navigateWithSummary(...)`, then passes the resulting summary text to the helper. It clears review state only after both navigation and todo creation succeed.

## Data Flow

1. User runs `/end-review` from an active fresh review branch.
2. User selects `Return and add findings to todo`.
3. The command navigates back to the saved review origin with `summarize: true` and the existing review-summary prompt.
4. The implementation obtains the generated branch summary text from the navigation result.
5. The helper creates one todo file containing the full summary.
6. Review state is cleared.
7. The user is notified that the review is complete and the todo was created.

## Error Handling

- If there is no active review origin, keep the existing `not in a review branch` behavior.
- If summarization is cancelled, navigation is cancelled, or summarization fails, do not create a todo.
- If the navigation result does not expose summary text, notify the user that todo creation could not proceed and leave the review state active so `/end-review` can be retried.
- If writing the todo fails, notify the user and leave the review state active so the user can retry or choose another end-review action.
- Preserve existing behavior for `Return only`, `Return and fix findings`, `Return and summarize`, and loop fixing.

## Testing

Add focused tests for the pure helper behavior:

- todo serialization uses the same JSON-front-matter-plus-body format as the file-based todo extension;
- generated titles use the review scope when present and fall back to `Review findings`;
- todo directory resolution honors `PI_TODO_PATH`.

Use direct command verification for the command wiring because it depends on Pi session-navigation APIs and TUI selection.
