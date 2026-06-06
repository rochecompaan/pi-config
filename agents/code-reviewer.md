---
name: code-reviewer
description: Legacy compatibility shim for older Superpowers wording. Disabled; use the Pi `reviewer` subagent instead.
disabled: true
---

# Disabled: use `reviewer`

`code-reviewer` has been consolidated into the canonical Pi `reviewer` subagent.

When a Superpowers skill says to dispatch `superpowers:code-reviewer` or `code-reviewer`, adapt that request to Pi by dispatching `reviewer` instead:

- Resolve the active reviewer team with `resolve_agent_team({ role: "reviewer" })` when available.
- Pass the resolved `model` and `thinking` to `subagent(...)` when present.
- Use `context: "fresh"` for adversarial review.
- Put the Superpowers code-review template fields (`WHAT_WAS_IMPLEMENTED`, `PLAN_OR_REQUIREMENTS`, `BASE_SHA`, `HEAD_SHA`, `DESCRIPTION`) into the `reviewer` task prompt.
