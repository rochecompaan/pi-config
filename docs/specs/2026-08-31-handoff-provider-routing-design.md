# Registry-Aware Handoff Prompt Generation Design

## Purpose

The handoff extension generates a prompt with the selected Pi model. The current implementation calls `@earendil-works/pi-ai/compat` directly.

That compatibility helper only knows its static API providers. It rejects models from dynamic providers, such as `claude-bridge`, before the provider receives the request.

## Goals

- Route handoff prompt generation through the active Pi model registry.
- Support built-in and dynamically registered providers.
- Remove duplicate authentication resolution from the handoff extension.
- Preserve manual and automatic handoff behavior.
- Separate prompt generation from command and session state.
- Add a regression test for custom provider routing.

## Non-Goals

- Change the `claude-bridge` provider.
- Add a provider-specific fallback.
- Change handoff commands, settings, countdown behavior, or session replacement.
- Select a different model for prompt generation.

## Architecture

`extensions/handoff.ts` remains responsible for commands, automatic state, countdowns, and session replacement.

A new `extensions/handoff-generation.ts` module owns prompt serialization and model completion. This split reduces the size of `handoff.ts` and creates a focused test boundary.

The generation module provides two narrow functions:

- `generateHandoffPrompt` manages the loader UI and conversation serialization.
- `completeHandoffPrompt` sends one prepared request through `ctx.modelRegistry.complete` and returns the generated text.

The main extension loads `generateHandoffPrompt` as its default generation dependency. Existing tests can continue to inject a generation dependency without loading Pi runtime packages.

## Data Flow

1. `performHandoff` makes sure that a model and handoff messages exist.
2. `generateHandoffPrompt` serializes the conversation and creates the handoff request.
3. `completeHandoffPrompt` calls `ctx.modelRegistry.complete` with `ctx.model`.
4. The model registry resolves authentication and the registered provider implementation.
5. The provider generates the response through its configured stream API.
6. The generation module returns the text to the existing handoff flow.

The request keeps `cacheRetention: "none"`, a new session ID, and the loader abort signal.

## Authentication and Provider Routing

The handoff extension no longer calls `getApiKeyAndHeaders`. The model registry owns authentication for the selected provider.

The extension also removes the direct `@earendil-works/pi-ai/compat` completion call. This change lets providers registered with `pi.registerProvider` supply custom stream implementations.

No provider name or API name appears in the routing logic.

## Error Handling

An aborted model response returns `null`. The existing handoff flow treats this result as a cancellation.

A generation error keeps the current loader behavior. The extension logs the error and returns `null` from the loader callback.

The existing automatic handoff policy remains unchanged. An unsuccessful automatic attempt disables further attempts until the user enables them again.

## Module Size

`extensions/handoff.ts` currently exceeds 400 lines and combines provider I/O with command state. The new module removes the provider I/O responsibility from that file.

The extraction is limited to prompt generation. It does not move command, state, settings, or session code.

## Test Design

Add `tests/extensions/handoff-generation.test.ts` with a custom model whose API name is not a built-in compatibility API.

The test supplies a model registry that accepts this custom model and returns generated text. The test calls `completeHandoffPrompt` and makes sure that it returns the provider text.

This test fails with the current static compatibility path. It passes only when generation uses the supplied model registry.

Remove the existing `resolveGenerationAuth` tests because the extension no longer owns authentication resolution.

Keep all command, automatic state, cancellation, and session replacement tests.

## Verification

Run these checks after implementation:

1. Run the new generation test and observe the expected failure before the production change.
2. Run all focused handoff tests after the production change.
3. Run the complete TypeScript test suite.
4. Run `nix build .#checks.x86_64-linux.pi-config-extension-load --no-link`.
5. Run `nix flake check --accept-flake-config --print-build-logs`.
6. Run a provider-routing probe with a custom registered API.

## Acceptance Criteria

- Manual and automatic handoff generation work with `claude-bridge`.
- Prompt generation works with any provider registered in the active model registry.
- The handoff extension does not import `@earendil-works/pi-ai/compat`.
- The handoff extension does not resolve provider authentication itself.
- Cancellation and generation errors keep their current user-visible behavior.
- Existing handoff tests pass.
- The Pi extension-load check and full flake check pass.
