# Context paging usage accounting

## Approved goal

The paging threshold must use the same provider-backed accounting as the Pi status bar.
The default budget remains `128_000` tokens.
The effective budget remains the smaller of this budget and the model context window.
The status bar itself does not change.

## Root cause

The selector currently adds estimates for the system prompt, active tools, and every canonical message.
Pi uses the last successful assistant usage plus estimates for messages after that assistant.
Provider usage includes cached tokens and can differ greatly from character-based estimates.
Paging keeps raw history, so later canonical input can also contain messages absent from the last provider request.

## Design

A small accounting module owns the link between measured usage and the actual selected provider context.
The extension reads `ctx.getContextUsage()` and supplies a calibrated full-context estimate to the selector.
The selector continues to remove coherent units in FIFO order.
It uses Pi estimates only for additions, removals, notices, and other unmeasured changes.

The tracker records each selected outgoing message set, its persistent-versus-outgoing-only provenance, and its resident inputs. Outgoing-only extension instructions and paging notices remain in the measured request but may disappear from the next canonical branch.
A successful provider response supplies the next measured anchor.
The anchor includes that response because Pi usage includes output tokens.
The estimate for another candidate equals the anchor total plus estimated differences from its message set and resident inputs.
Previously evicted raw history contributes only if the next candidate contains that history.
It must not disappear from accounting merely because a provider previously did not see it.

Resident inputs contribute once.
The measured total already includes the system prompt and tool schemas.
A resident change contributes an estimated delta, not another full resident estimate.
The selector must not reject an observed within-budget request solely because its raw estimate is larger.
Protected-exchange overflow and recovery checks use the same calibrated accounting.
Reported token counts remain finite and nonnegative.

## Anchor safety

Only successful, nonzero usage can establish a measured anchor.
Error and aborted responses cannot establish an anchor.
Retries without a new measured response must not rebase against a pruned canonical branch.
Message matching must survive reconstructed message objects and preserve duplicate message occurrences. It strictly matches persistent messages in order, while allowing only recorded outgoing-only messages to disappear.
Transient notices belong to the outgoing snapshot, not stored history.

Session changes, branch changes, model changes, compaction, and context edits invalidate incompatible anchors.
The tracker must not consume an earlier model or pre-edit usage as a fresh anchor.
An unknown or unmatchable usage basis uses the existing estimator until a tracked request supplies valid usage.
This fallback also applies to undefined, null, nonfinite, negative, and unsupported usage data.
No new session entries or external dependencies are necessary.

## Scope

Changes remain in `extensions/context-paging` and its existing documentation.
Raw session history and recovery tools remain unchanged.
No provider-specific tokenizer, footer change, budget change, dependency update, or standalone extension release is part of this work.

## Verification

Automated tests cover both directions of heuristic mismatch, cached usage, repeated paging, tool continuations, and duplicate message matching.
Tests also cover resident inputs counted once, retries, failed responses, and invalidation.
Existing FIFO, active-request, protected-exchange, recovery, and large-output tests remain green.
The runtime extension-load check and full flake check verify packaging and extension startup.
No new tests assert static Nix settings or documentation text.

## Accuracy limit

The measured anchor can match Pi exactly.
A changed request remains an estimate until its provider response reports actual usage.
This design does not claim an exact tokenizer or an absolute pre-request token guarantee.
