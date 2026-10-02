# Claude bridge paging during active tool queries

## Goal

The Claude bridge must honor the context selected by Pi during tool continuations.
The existing 128,000-token paging budget remains unchanged.
The saved session remains unchanged.

## Current behavior

Pi runs its context hook before each provider call, including calls after tool execution.
The paging extension removes old messages or replaces old tool output with recovery references.
The bridge checks history identity when it starts a query.
However, an active tool continuation bypasses that check and resumes its existing Claude Code query.
That query still holds the messages that Pi removed.
Its reported usage then describes a different context from the selected Pi context.

The existing `pi-claude-bridge-paging-history-sync.patch` covers completed queries, not active tool continuations.
The bridge source comes from a pinned upstream snapshot.
This repository maintains its package patches and regression tests.
No separate local bridge repository exists.

## Approaches

1. **Restart only after a context rewrite (selected).** Preserve the active query for append-only tool results. Rebuild after paging changes retained history.
2. **Restart after every tool exchange.** This removes stale query state, but discards the prompt cache even without paging.
3. **Change the paging budget or its usage accounting.** This hides the divergence without making the provider honor the selected context.

## Design

### History identity

Each query records the non-system messages that its provider context contains.
The snapshot includes message content and tool-call identity, not only message counts or timestamps.
A continuation can reuse its query only if the current context starts with that snapshot.
Append-only tool results preserve reuse.
Eviction, changed recovery notices, and replaced old tool output invalidate reuse.

The query records the full selected history after every accepted tool continuation.
This catches later rewrites within the same user turn.
Rendered system and tool metadata remain outside the message identity comparison.

### Rewrite handling

Before the bridge delivers results to parked MCP handlers, it checks the owning query's history snapshot.
If the history changed, the bridge retires that query and starts a replacement from the selected context.
The replacement receives all retained messages from the active turn, including its completed tool exchanges and latest results.
The existing plain-text reconstruction protects Claude assistant signatures during this rebuild.
A short continuation prompt asks the replacement to continue the task from those results.

The bridge must not treat these results as orphaned results or return an empty assistant response.
It must not run completed tools again as part of the restart.
Images and user instructions retain the existing bridge transport behavior.
Normal steering keeps its existing order before tool-result delivery.

### Query ownership and teardown

The old query stops before its parked handlers release.
Its pending prompt acknowledgments and MCP handlers settle so no promise remains parked.
Its session cannot supply the replacement's context.
A new query uses a fresh session identity if the old subprocess can still write its session file.

Late messages, errors, completion handlers, and cleanup from the old query cannot modify the replacement.
Retirement removes the old abort listener and result-routing ownership.
An unrelated active query remains unchanged.
Reentrant queries retain their own result routing and do not take over the parent's stream.
A user abort still stops the replacement.

### Package integration

A package patch implements the continuation change beside the existing bridge history patches.
The Nix package applies it after the history-sync patch.
The package runs the new behavioral regression tests during its install check.
The upstream source revision and dependency lock remain unchanged unless the implementation requires a dependency change.

## Acceptance criteria

- Append-only tool continuations keep the same SDK query.
- Paging between tool calls creates a replacement query without the evicted text.
- Replacing an older tool result with a recovery reference triggers a replacement, even with unchanged message timestamps.
- The replacement contains the newest tool results and retained user instructions exactly once.
- A second paging event within the same user turn triggers another safe replacement.
- Old query callbacks cannot end or corrupt the replacement stream.
- Unrelated queries and normal steering keep their current behavior.
- Abort handling settles pending work and ends the correct stream.
- The saved session and paging budget remain unchanged.
- Genuine resident-input or protected-context overflow still produces the existing explicit error.

## Verification

The new tests exercise provider continuation and teardown behavior with a controlled SDK boundary.
They must fail against the current bridge before implementation.
The tests do not call a live model or consume API credits.
The existing bridge regression tests and context-paging tests remain part of verification.

Final package verification includes these commands:

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
```

The local package must pass a Home Manager-like startup path without extension-loading errors.
A live reproduction remains optional because it consumes model credits and cannot replace deterministic regression tests.

## Baseline evidence

On the task worktree at `8054025`, the context-paging suite passed all 96 tests.
The three existing bridge regression files passed all 11 tests.
The full flake check completed with exit status zero.
Node requires standalone copies of packaged TypeScript modules outside `node_modules` for its built-in type stripping.
The baseline bridge tests used the same copy approach as the package install check.

## Non-goals

This change does not increase the budget, weaken overflow checks, alter saved session data, or change Claude Code's model window.
It does not add a new context-management interface or update unrelated extensions.
Deployment to the active Home Manager profile remains a separate user-approved action.
