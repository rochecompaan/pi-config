# Pi Agent Profiles

This directory contains project-owned Pi agent profiles shared across selectable workflow suites and pi-subagents workflows.

## Hybrid builtin roles

These profiles intentionally shadow same-named pi-subagents builtins so the project can retain its review and implementation guardrails while incorporating useful builtin coordination behavior:

- `scout.md` — focused repository reconnaissance and handoff context.
- `planner.md` — approved-scope implementation planning.
- `reviewer.md` — fresh-context, read-only adversarial review.
- `worker.md` — standard single-writer implementation.

Their model and thinking fields are intentionally absent. `settings.json` owns role model routing through `subagents.agentOverrides`.

All four profiles use:

```yaml
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
```

Project instructions remain available through inherited context. Broad skill discovery is disabled for ordinary children; required task-specific skills are passed explicitly by the parent task.

## Custom roles

- `mechanical-worker.md` — narrow deterministic implementation.
- `code-reviewer.md` — disabled compatibility shim documenting migration to the canonical `reviewer` role.

## Installation

The Nix `pi-config` package copies this directory and exposes it through Home Manager and project Pi shell resources. Do not install these files manually or symlink them from a workflow-suite checkout.
