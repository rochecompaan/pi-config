# Review Model Selection Design

## Goal

Allow an `Empty branch` code review to use a different model from the main working branch. For example, the main branch can continue with `openai/gpt-5.6-sol` while the review branch uses Kimi K3 or Fable.

The selected model must be isolated to the review branch. Pi 0.82.1 tree navigation does not rebuild the active runtime model, so the active review state records the original model identity as restoration metadata and `/end-review` explicitly restores it after returning to the origin.

## User Interface

The existing target, profile, and session-mode flow remains in place.

When a review will start in an `Empty branch`, show a model picker before changing the session tree. This applies to:

- bare `/review` invocations that use the interactive target selector;
- direct invocations such as `/review branch main`;
- empty Pi sessions, where the extension already defaults to fresh review mode.

The picker appears every time and reuses Pi's publicly exported `ModelSelectorComponent`. It retains Pi's existing fuzzy search, bounded viewport, provider/model rendering, catalog refresh behavior, and current-model highlighting instead of rendering a separate flat list of every model.

The picker does not remember a previous review model. Selecting the already-current model preserves existing behavior and does not append a redundant model change.

`Current session` reviews do not show the picker and continue using the active model. Cancelling the picker cancels the review before any branch or model state changes.

## Architecture

Add `extensions/review/review-model.ts` to own the model-selection logic rather than adding another responsibility to the already large `extensions/review/index.ts` module.

The helper module owns:

- presenting Pi's exported `ModelSelectorComponent` through `ctx.ui.custom()`;
- adapting only the public `ModelRegistry` methods needed by the component (`refresh()`, `getAvailable()`, `find()`, and `getError()`), without reaching into Pi's private runtime state;
- supplying a no-op settings adapter so choosing a review model in the component does not independently persist a new default before the extension applies the branch-local switch;
- passing the current model to Pi's component so its existing highlight/default behavior is preserved;
- representing cancellation, current-model selection, and alternate-model selection as distinct results;
- wrapping model switches so `false` returns and thrown authentication/runtime errors become explicit failure results;
- representing original models as serializable `{ provider, modelId }` identities and resolving them through the public model registry for restoration.

`extensions/review/index.ts` remains responsible for orchestration:

- deciding whether the review uses `Empty branch` or `Current session`;
- displaying the picker for `Empty branch` reviews;
- creating and navigating to the review branch;
- applying the selected model only after branch navigation;
- persisting the original model identity in active review state when an alternate model is selected;
- activating review state and dispatching the review prompt only after the model switch succeeds;
- explicitly restoring the original model after `/end-review` navigation and before clearing review state or performing post-return side effects;
- navigating back to the review leaf if original-model restoration fails.

No preferred review model is added to review settings or persisted custom entries. The active review entry may contain the original model identity solely as restoration metadata; it is not used as a future review default.

## Data Flow

1. Parse the review target, profile, and extra instructions with the existing flow.
2. Preserve the existing loop-fixing path; it does not enter the `Empty branch` flow and therefore does not select another model.
3. Determine session mode as today.
4. If `Current session` is selected, call the existing review execution path without a review-model override.
5. If `Empty branch` is selected or implied for an empty session:
   1. Open Pi's existing `ModelSelectorComponent` through the review-model helper.
   2. Let the component use the registry's available-model snapshot and normal refresh behavior, with the current model highlighted and fuzzy search available immediately.
   3. On cancellation, return immediately.
   4. Pass the selected model result to `executeReview()`.
6. `executeReview()` captures the current model identity, saves the origin, and navigates to the review branch using the existing logic.
7. If an alternate model was selected, call `pi.setModel()` after navigation and before appending active review state or sending the review prompt.
8. Pi appends `model_change` on the review branch. Persist the original model identity in the active `review-session` entry, then let the selected model handle the full review, including tool use and additional turns.
9. `/end-review` captures the current review leaf and original model identity before summarizing or navigating to the origin.
10. After successful navigation, resolve the original model through `ctx.modelRegistry.find()` and call `pi.setModel(originalModel)` before clearing review state, creating a findings todo, or queuing a fix prompt. This appends an explicit restoring `model_change` on the origin branch and resets Pi's saved default to the main working model.
11. If the active review entry predates this feature and has no original model identity, preserve the existing return behavior because no alternate review model was recorded.

## Error Handling

- If Pi's available-model snapshot is empty, notify the user and leave the session unchanged.
- Picker cancellation leaves the session tree, review state, widget, editor, and model unchanged.
- If a selected model can no longer be found, notify the user and cancel before branch creation.
- If the initial `pi.setModel()` returns `false` or throws after branch navigation:
  - do not append active review state;
  - do not show the active-review widget;
  - do not send the review prompt;
  - navigate back to the saved origin without summarization;
  - explicitly restore the original model in case the failed switch changed runtime state before throwing;
  - clear the in-memory review origin;
  - notify the user of the model-switch failure.
- If startup rollback navigation or original-model restoration also fails, report every failure. The extension still must not send the review prompt or mark the review active.
- If `/end-review` reaches the origin but cannot resolve or activate the original model:
  - do not clear review state, create a findings todo, queue a fix prompt, or report success;
  - navigate back to the captured review leaf without summarization so the review model and active state remain recoverable;
  - report the restoration failure and any rollback failure, then let the user repair authentication and retry `/end-review`.

## Testing

Add `extensions/review/review-model.test.ts` for behavior that can regress independently of Pi's internal UI implementation:

- the wrapper passes the current model and public registry adapter to Pi's `ModelSelectorComponent`;
- registry refresh, available-snapshot, and exact-model lookup delegate through the public `ModelRegistry` surface;
- cancellation, current-model selection, and alternate-model selection are distinct;
- selecting the current model does not invoke the switch callback;
- a failed or throwing switch returns failure so prompt dispatch remains guarded;
- original model identities serialize without carrying registry/runtime objects;
- restoration is a no-op when Pi already has the original model;
- missing, unauthenticated, and throwing original-model restores return explicit failures;
- successful `/end-review` ordering is `navigate origin -> restore original model -> clear/continue`;
- restoration failure returns to the review leaf without clearing active review state or dispatching post-return work.

Run all review-extension tests with Node's test runner.

Run the packaged runtime extension-load check:

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Use focused orchestration verification to confirm the ordering `navigate branch -> switch model -> activate/send` and `navigate origin -> restore original model -> clear/continue`. Verify that startup switch failure rolls back without prompt dispatch and end-review restoration failure rolls back to the review leaf without clearing active state.

Run a direct Pi TUI smoke test for the native picker, fuzzy search, cancellation, alternate-model activation, and `/end-review` restoration because extension-load checks alone do not execute the selector or navigation lifecycle.

## Non-Goals

- Selecting another model for `Current session` reviews.
- Changing loop-fixing review model behavior.
- Adding a `--model` argument.
- Persisting a preferred review model.
- Selecting a separate review thinking level or tool set.
- Adding provider login or credential setup to the review flow.
- Reimplementing Pi's model catalog list, filtering, search, or rendering.
- Replacing the existing branch-based review lifecycle with a separate Pi session.
