# Claude Bridge Direct Completion Design

## Context

The `/handoff` command calls `ctx.modelRegistry.complete()` with a one-message context. The context contains the handoff system prompt and omits the optional `tools` field.

The Claude bridge handles this call with its normal agent stream. That stream resolves each system prompt through `PromptCaptures`. The handoff call does not emit `before_agent_start`, so the bridge has no capture for the 883-character prompt. The bridge rejects the call to prevent silent instruction loss.

A Zellij reproduction confirmed this sequence with `claude-bridge/claude-sonnet-4-6`. One normal turn succeeded and created one capture. The next `/handoff` command failed because its system prompt had no capture.

This fault is separate from Claude history reconstruction. The previous fix remains valid and must stay unchanged.

## Root Cause

`ModelRegistry.complete()` forwards its `Context` to the provider without an agent lifecycle event. The bridge cannot assume that all provider calls are normal agent turns.

Pi distinguishes the two request shapes at the provider boundary:

- `Agent.createContextSnapshot()` always supplies `tools`, including `tools: []` when no tools are active.
- Direct `ModelRegistry.complete()` examples omit the optional `tools` field.

The bridge already has an isolated stream for one-message internal completions. This stream uses `context.systemPrompt` directly. It also disables tools, settings sources, skills, and session persistence. It does not synchronize the shared Claude session.

## Goals

1. Make the handoff direct completion work with Claude bridge models.
2. Keep direct completions separate from the live shared Claude session.
3. Preserve the exact system prompt that the direct caller supplies.
4. Preserve strict prompt-capture checks for normal agent calls.
5. Add a regression for the exact 883-character handoff prompt.
6. Keep the previous history-reconstruction behavior and tests intact.

## Non-Goals

- Do not change `extensions/handoff-generation.ts` to know Claude bridge details.
- Do not add a bridge-specific flag to every direct-completion caller.
- Do not weaken `PromptCaptures.resolveOrDerive()`.
- Do not support tools in the isolated completion stream.
- Do not expand the isolated stream to support multi-message conversations.
- Do not change Claude session reconstruction.
- Do not update the upstream bridge version in this change.

## Provider Boundary

Add a small pure router to the bridge patch. The router selects a handler before the normal stream reads prompt captures or shared-session state.

The router selects the isolated handler when `context.tools === undefined`. It passes the context system prompt to that handler without modification.

The router selects the agent handler when the context has a `tools` field. This includes `tools: []`.

The provider entry point becomes a small wrapper around this router:

1. The isolated handler calls the existing isolated stream.
2. The agent handler calls the current capture-protected stream.
3. Only the agent handler can resolve prompt captures.

The pure router will live in a focused bridge source file. This boundary keeps the policy testable without loading the Claude SDK or Pi peer dependencies.

## Direct Completion Flow

The direct flow is:

1. `/handoff` calls `ModelRegistry.complete()`.
2. Pi forwards a context with `systemPrompt`, one user message, and no `tools` field.
3. The bridge router selects the isolated handler.
4. The bridge sends the user message through its existing isolated stream.
5. The isolated stream sends `context.systemPrompt` directly to Claude Code.
6. The isolated stream sets `persistSession: false`.
7. The result returns to `/handoff` without changing the shared Claude session.

The existing isolated stream requires exactly one user message. It returns a provider error for other context shapes. This safe error is preferable to importing an unsupported context into the shared session.

## Normal Agent Flow

The normal agent flow does not change:

1. Pi supplies a context with a `tools` field.
2. The bridge router selects the agent handler.
3. The bridge calls `PromptCaptures.resolveOrDerive()`.
4. An exact capture or safe derived capture proceeds.
5. An unknown rewritten or stripped prompt throws the existing error.

A normal no-tools run still supplies `tools: []`. Therefore, it remains protected by prompt capture.

## Rejected Approaches

### Bypass Capture in the Shared Stream

The bridge could append an uncaptured prompt directly and continue through the shared stream. This approach is unsafe.

The shared stream can resume, rebuild, replace, or clear the live Claude session. A handoff completion must not affect that session.

### Add Bridge Metadata to `/handoff`

The handoff call could pass a bridge-specific marker in request metadata. This approach creates provider coupling in the extension.

Other direct-completion callers need the same bridge knowledge. Existing Pi examples use the omitted-tools shape, so provider-boundary routing is smaller and more general.

### Embed the Captured Agent Prompt

The handoff extension could wrap its prompt around the captured normal-agent prompt. This approach forwards unrelated context files, skills, and instructions into a focused helper request.

It also makes `/handoff` depend on prompt-capture internals. The provider boundary is the correct place for this distinction.

## Test Design

### Bridge Regression

Add a Nix install-check test for the pure request router.

The regression will:

1. Define the exact handoff system prompt.
2. Assert that its length is 883 characters.
3. Build a direct context that omits `tools`.
4. Give the agent handler a fake prompt-capture error.
5. Assert that the isolated handler receives the exact prompt.
6. Assert that the direct context does not call the agent handler.
7. Add `tools: []` to the same context.
8. Assert that this context calls the agent handler and throws the fake capture error.

The last assertion protects the prompt-capture boundary. The bridge must not treat a normal agent call as an isolated completion.

### Existing Regressions

Run the existing history-reconstruction regression without changes. It must still cover transcript fallback and AskClaude session planning.

Run the focused handoff tests:

```sh
node --test --experimental-strip-types \
  tests/extensions/handoff-generation.test.ts \
  tests/extensions/handoff.test.ts
```

No new handoff-extension test is necessary. Existing tests already prove that handoff generation sends the custom system prompt through `ModelRegistry.complete()`. The new bridge regression proves the missing provider behavior.

### Runtime Reproduction

After the packaged fix is built, run the Zellij scenario again:

1. Start Pi with the built `pi-config` resources.
2. Select `claude-bridge/claude-sonnet-4-6`.
3. Complete one normal turn.
4. Run `/handoff` with a short goal.
5. Confirm that generation reaches the handoff editor.
6. Confirm that no prompt-capture error appears.
7. Cancel the editor and remove the temporary Zellij session.

Use a temporary Pi agent directory for this test. Do not replace the installed global configuration.

## Files

The implementation will modify or add these files:

- `nix/packages/pi-claude-bridge-safe-history-reconstruction.patch`
- `nix/packages/pi-claude-bridge-direct-completion.test.mjs`
- `nix/packages/pi-deps.nix`

The patch will add the pure request-router source file and route the provider entry point through it.

The handoff extension files do not need production changes.

## Packaging

`pi-deps.nix` will expose the new regression file to the bridge install check. The check will copy the patched pure TypeScript module to a temporary path.

Node will run both bridge regression files with `--test --experimental-strip-types`. This arrangement does not require bridge peer dependencies during the install check.

## Verification

Run these commands after implementation:

```sh
node --test --experimental-strip-types \
  tests/extensions/handoff-generation.test.ts \
  tests/extensions/handoff.test.ts
```

```sh
nix build .#packages.x86_64-linux.pi-config --no-link
```

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

```sh
nix flake check --accept-flake-config --print-build-logs
```

The bridge package build must run both bridge regression files. The final report must include the live Zellij result and each command result.

## Acceptance Criteria

- The exact 883-character handoff prompt takes the isolated direct-completion path.
- The isolated path preserves the prompt exactly.
- The isolated path does not resume, persist, replace, or clear the shared Claude session.
- A context with `tools: []` stays on the normal capture-protected path.
- Unknown normal-agent prompts still throw the existing prompt-capture error.
- Existing history-reconstruction tests pass.
- Focused handoff tests pass.
- The `pi-config` package builds.
- The extension-load check passes.
- The full flake check passes.
- The Zellij reproduction reaches the handoff editor with Claude bridge Sonnet.
- No changes are pushed without explicit permission.
