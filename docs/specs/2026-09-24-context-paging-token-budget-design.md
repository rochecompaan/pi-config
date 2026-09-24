# Configurable Context-Paging Token Budget

**Date:** 2026-09-24

**Status:** Approved design

## Goal

Make the rolling context token budget configurable through Pi settings. Change the default budget from 64,000 tokens to 128,000 tokens.

The extension must continue to preserve complete model exchanges. The extension must also retain its existing model-window limit and temporary overflow behavior.

## Scope

This change adds one setting:

```json
{
  "contextPaging": {
    "enabled": true,
    "tokenBudget": 128000
  }
}
```

The setting controls the estimated token budget for normal context selection. The setting does not control output page size or history recovery limits.

## Settings Contract

`contextPaging.tokenBudget` is optional. Its default value is `128000`.

A valid value is a positive safe integer. Zero, negative numbers, fractions, strings, arrays, objects, and unsafe integers are invalid.

The extension resolves the value in this order:

1. Use a valid value from trusted project settings.
2. Otherwise, use a valid value from global settings.
3. Otherwise, use the default value of `128000`.

The extension ignores project settings when the project is not trusted. An invalid project value does not hide a valid global value.

The existing `contextPaging.enabled` setting keeps the same precedence and fallback behavior.

## Architecture

The settings resolver returns one resolved settings object. This object contains `enabled` and `tokenBudget`.

The extension stores the resolved object for the session. The `context` event passes `tokenBudget` to the context selector as explicit input.

The selector does not read settings files or mutable module state. This boundary keeps selection deterministic and makes custom budgets easy to test.

The fixed default remains an exported constant. Its name must describe that it is a default, not the active budget.

## Budget Calculation

The selector calculates the effective budget as follows:

```ts
Math.min(configuredTokenBudget, modelContextWindow)
```

If the model does not declare a context window, the configured token budget is the effective budget.

The existing resident-input checks remain unchanged. The existing protected-exchange overflow behavior also remains unchanged.

## Paging Notice

The paging notice must report the effective budget. It must not contain a fixed `64,000` or `128,000` value.

For example, a configured budget of `128000` produces this text when the model window does not reduce it:

```text
Older context left the 128,000-token rolling window. Raw session history is unchanged.
```

If the model window reduces the budget, the notice reports the reduced value.

## Error Handling

Invalid token budget values do not stop session startup. The resolver falls through to the next valid settings source or the default.

The selector keeps its current errors for resident input that exceeds the effective budget. No new user notification is necessary for invalid settings.

## Tests

Automated tests will cover these behaviors:

- The default token budget is `128000`.
- A valid global token budget overrides the default.
- A valid trusted project token budget overrides the global value.
- An untrusted project token budget is ignored.
- An invalid project value falls through to a valid global value.
- Invalid values fall through to the default when no valid source exists.
- The selector uses a custom token budget.
- The model context window can reduce the configured budget.
- The paging notice shows the effective budget.
- Existing protected-exchange overflow behavior remains unchanged.

The tests will use the existing Node test runner and context-paging test files.

## Documentation

This design supersedes the fixed-budget requirements in `docs/specs/2026-09-21-context-paging-design.md`. The earlier design and its implementation plan remain unchanged as historical records.

## Acceptance Criteria

1. Users can set `contextPaging.tokenBudget` in global settings.
2. Trusted projects can override the global value.
3. Invalid values fall through without an extension startup error.
4. The default budget is 128,000 estimated tokens.
5. The effective budget never exceeds the declared model context window.
6. Paging notices show the effective budget.
7. All context-paging tests pass.
