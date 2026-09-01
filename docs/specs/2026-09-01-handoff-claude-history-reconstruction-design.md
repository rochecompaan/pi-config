# Handoff and Claude History Reconstruction Design

## Context

The `/handoff` command generates a prompt through the selected Pi model. Provider errors can contain no text and use `stopReason: "error"`.

The current generation path joins text blocks for every non-aborted response. It therefore changes an error response into an empty string.

The manual flow opens its editor before it rejects empty output. The automatic flow already rejects whitespace-only output before it creates a session.

The `pi-claude-bridge` provider rebuilds Claude sessions after Pi history changes. The `session_tree` event marks the shared Claude session for this rebuild.

Bridge version `0.7.0` converts normalized Pi messages into Anthropic messages. This conversion changes information that Anthropic requires the client to replay without changes.

The conversion can filter blocks, remove `redacted_thinking`, sanitize tool IDs, repair message groups, and create new Claude records. Signed thinking text and signatures can remain equal while their containing assistant turn changes.

Anthropic rejects this reconstructed turn with the following error:

```text
thinking or redacted_thinking blocks in the latest assistant message cannot be modified
```

## Goals

- Preserve provider error messages during handoff generation.
- Reject truncated handoff prompts.
- Reject empty handoff prompts in manual and automatic flows.
- Never open the manual editor with an empty generated prompt.
- Keep explicit cancellation behavior.
- Prevent signed Claude content from entering a lossy reconstruction path.
- Keep normal Claude session resume behavior unchanged.
- Add regression coverage for a tree rebuild after a multi-tool thinking turn.
- Package the bridge repair through the existing Nix dependency derivation.

## Non-Goals

- Change the intentional manual editor step.
- Select a different model for handoff generation.
- Rebuild Claude history from copied raw JSONL records.
- Add a permanent fork of `pi-claude-bridge`.
- Change unrelated bridge session, prompt-cache, or tool behavior.

## Handoff Completion Contract

`completeHandoffPrompt` classifies the model response by `stopReason`.

- `aborted` returns `null`.
- `error` throws an error that contains `response.errorMessage`.
- `length` throws a truncation error.
- `stop` joins all text blocks in their response order.
- A whitespace-only successful result throws an empty-output error.
- Any other stop reason throws an incomplete-generation error.

The function returns the original nonempty text. It does not remove intentional leading or trailing whitespace.

`generateHandoffPrompt` keeps the loader and its abort action. An internal tagged result carries asynchronous errors out of the UI callback.

The function returns `null` only for cancellation. It rejects for provider errors, truncation, empty successful output, and unexpected stop reasons.

## Handoff Command Flow

`performHandoff` keeps a second empty-output guard before it selects the manual or automatic path. This guard protects callers that inject another generation function.

For a manual handoff, empty output shows an error notice. The command does not open the editor or create a session.

For an automatic handoff, empty output disables retries. The existing notice tells the user how to enable automatic handoff again.

Generation errors keep the existing command policy. Manual commands reject with the original error. Automatic commands show the error and disable retries.

The manual editor still receives each nonempty generated prompt. An edited prompt remains staged in the new session for user review.

## Claude Reconstruction Strategy

The bridge keeps its current resume path when Pi history still matches the shared Claude session. Claude Code then reads its original session records.

A rebuild cannot safely recreate prior Claude assistant turns from normalized Pi messages. Pi history does not prove the original block grouping or the presence of removed redacted blocks.

The patched bridge uses two reconstruction plans:

1. Histories without a prior `claude-bridge` assistant turn use the existing import path.
2. Histories with a prior `claude-bridge` assistant turn use a fresh Claude session and plain transcript context.

The second plan does not delete or resume the previous Claude session. The next query creates a new Claude session for the selected Pi branch.

The transcript is deterministic. It contains visible user text, visible assistant text, tool names, tool arguments, and tool results.

The transcript excludes thinking text, thinking signatures, redacted thinking data, and tool IDs. It enters Claude Code as user text before the current prompt.

If the current prompt contains images, the bridge adds the transcript as the first text block. It keeps the current image blocks in their original order.

This strategy does not synthesize signed assistant messages. It trades prompt-cache reuse for a valid and self-contained request when exact replay is impossible.

## Module Boundaries

`extensions/handoff-generation.ts` owns completion result handling and loader error transport.

`extensions/handoff.ts` owns command policy, notices, editor use, and session replacement.

A new pure bridge module owns reconstruction planning and transcript serialization. The large bridge entry module only selects and applies the plan.

The Nix package applies a repository-local patch to `pi-claude-bridge` version `0.7.0`. The patch is temporary until an upstream release contains the repair.

## Test Design

`tests/extensions/handoff-generation.test.ts` covers these cases:

- A provider error exposes `errorMessage`.
- A length stop rejects the partial response.
- A successful empty response rejects.
- A successful whitespace-only response rejects.
- A loader generation error rejects instead of returning `null`.
- An abort still returns `null`.

`tests/extensions/handoff.test.ts` covers these command behaviors:

- A manual empty result does not open the editor.
- A manual generation error does not open the editor or create a session.
- An automatic empty result disables retries and submits nothing.
- An automatic generation error disables retries and submits nothing.
- Existing successful manual and automatic behavior stays unchanged.

The bridge package install check imports the pure reconstruction module. Its fixture contains one signed thinking block and two tool calls in one assistant turn.

The regression makes sure that the planner selects transcript fallback. It also makes sure that the transcript contains no signatures, thinking data, or tool IDs.

The upstream bridge change needs a full event-level regression. That test fires `session_tree`, runs the next query without `resume`, and inspects the transcript-prefixed prompt.

## Packaging

The Nix derivation keeps the published `0.7.0` source and current package lock. Its `postPatch` phase applies the local bridge patch after it copies the package lock.

The install check keeps the Claude binary version check. It then runs the reconstruction regression with Node.js type stripping.

A future bridge release can remove the patch and test adapter. The version bump must keep equivalent upstream regression coverage.

## Verification

Run the focused handoff tests:

```sh
node --test --experimental-strip-types \
  tests/extensions/handoff-generation.test.ts \
  tests/extensions/handoff.test.ts
```

Build the patched bridge package and run its install check:

```sh
nix build .#packages.x86_64-linux.pi-config --no-link
```

Run the required Pi extension-load check:

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Run the full flake check:

```sh
nix flake check --accept-flake-config --print-build-logs
```

## Upstream Work

Submit the bridge source change and event-level regression to `elidickinson/pi-claude-bridge`.

The upstream report must explain why normalized Pi history cannot preserve every signed Claude assistant array. It must also describe the fresh-session fallback.

If `cc-session-io` later supports exact record-prefix cloning, the bridge can evaluate raw replay as a separate change. That change needs branch and attachment regressions.

## Acceptance Criteria

- Provider errors keep their original messages.
- Truncated output never becomes a handoff prompt.
- Empty generated output never opens the manual editor.
- Empty generated output never creates an automatic replacement session.
- Cancellation remains distinct from an error.
- Tree reconstruction never synthesizes a prior Claude assistant turn from normalized Pi blocks.
- The multi-tool thinking-turn regression passes.
- The focused tests pass.
- The bridge install check passes.
- The Pi extension-load check passes.
- The full flake check passes.
