# Subagent Prompt and Model Routing Design

## Goal

Configure pi-subagents so each role uses an appropriate GPT-5.6 tier without sacrificing the project-specific prompt quality and Superpowers workflow behavior currently encoded in `agents/`.

The configuration must keep model selection separate from role prompts, preserve project instructions, avoid indiscriminately exposing every installed skill to every child, and ensure required Superpowers skills are explicitly available for the tasks that need them.

## Current State and Root Cause

The Nix package copies `agents/` into `pi-config`, Home Manager links it into `~/.pi/agent/agents`, and `projectPiShellHook` also links it into `.pi/agents`. Project agents win over user agents and built-ins, so the repository profiles are active.

The `/subagents-models` diagnostic is misleading for this use case because it intentionally reports only the builtin-agent model layer. It does not show which same-named user or project profile wins at execution time.

pi-subagents applies `subagents.agentOverrides` differently to built-ins and custom agents:

- Builtin fields are replaced by matching settings overrides.
- Custom-agent fields are filled only when the field is absent from frontmatter.

The current custom profiles declare `model` and `thinking`, so settings-based routing cannot change those fields. The profiles also use `inheritSkills: false`, which passes `--no-skills` to child Pi processes and disables automatic skill discovery.

## Design Principles

1. **Retain project-owned role prompts.** The custom profiles contain valuable Superpowers adaptations and project-specific review and scope guardrails.
2. **Merge, do not blindly replace.** Incorporate stronger pi-subagents 0.34.0 coordination and execution rules where they improve the custom prompts.
3. **Separate prompts from model policy.** Remove `model` and `thinking` from custom role frontmatter and configure them through `settings.json`.
4. **Keep project context.** All role agents retain `inheritProjectContext: true`, ensuring `AGENTS.md` remains in the child prompt.
5. **Use focused skill injection.** Keep `inheritSkills: false` and pass required Superpowers skills explicitly per run.
6. **Preserve child boundaries.** Ordinary role agents remain concrete workers, planners, scouts, and reviewers; they do not become nested orchestrators.
7. **Avoid implicit artifact files.** Do not adopt builtin `output`, `defaultReads`, or `defaultProgress` defaults wholesale. Superpowers workflows already use explicit brief, report, diff, plan, and ledger paths; implicit `context.md`, `plan.md`, or `progress.md` files could be stale or conflict with project-required paths.

## Frontmatter Contract

The four hybrid profiles use this frontmatter policy:

| Role | Tools | Prompt mode | Project context | Skill discovery | Default context |
|---|---|---|---|---|---|
| `scout` | `read, grep, find, ls, bash, write, contact_supervisor` | `replace` | `true` | `false` | `fresh` |
| `planner` | `read, grep, find, ls, bash, write, contact_supervisor` | `replace` | `true` | `false` | `fork` |
| `worker` | `read, grep, find, ls, bash, edit, write, contact_supervisor` | `replace` | `true` | `false` | `fork` |
| `reviewer` | `read, grep, find, ls, bash, contact_supervisor` | `replace` | `true` | `false` | `fresh` |

All four omit `model`, `thinking`, `output`, `defaultReads`, and `defaultProgress`. Model and thinking come from settings; output, read handoffs, and progress paths come from each run's explicit contract. The reviewer remains unable to edit or write project files.

## Verified Prompt and Skill Composition

`systemPromptMode: replace` replaces Pi's generic base prompt, but Pi still appends context files and enabled skills. It does not by itself suppress `AGENTS.md` or skills.

`inheritSkills: false` is the control that disables automatic skill discovery. Explicit skills remain supported: pi-subagents resolves the selected skill, injects its name, description, and path into the child prompt, and ensures the child has the `read` tool needed to load the skill. Pi's explicit `--skill` behavior is additive even when normal discovery is disabled.

Every hybrid role prompt will include this contract:

> Explicitly injected skills are part of the task contract. Read each matching skill before acting and follow it unless it conflicts with project instructions or the approved task scope.

This preserves focused role prompts while preventing unrelated workflow skills and hard gates from activating inside every child.

## Model Routing

Configure the packaged `settings.json` with these defaults:

| Agent | Model | Thinking |
|---|---|---|
| `scout` | `openai-codex/gpt-5.6-luna` | `low` |
| `delegate` | `openai-codex/gpt-5.6-luna` | `low` |
| `researcher` | `openai-codex/gpt-5.6-terra` | `medium` |
| `context-builder` | `openai-codex/gpt-5.6-terra` | `medium` |
| `planner` | `openai-codex/gpt-5.6-sol` | `xhigh` |
| `worker` | `openai-codex/gpt-5.6-terra` | `high` |
| `reviewer` | `openai-codex/gpt-5.6-terra` | `high` |
| `oracle` | `openai-codex/gpt-5.6-sol` | `high` |

The parent may override a particular worker or reviewer run to Sol for unusually difficult implementation, security, concurrency, or architecture work.

## Hybrid Role Prompts

### Scout

Retain the custom profile's explicit fresh context, no-implementation boundary, dependency tracing, and stop-when-sufficient behavior.

Add the builtin prompt's stronger requirements to:

- avoid guessing;
- prefer targeted search and selective reading;
- identify entry points, types, interfaces, data flow, dependencies, likely change locations, risks, and open questions;
- cite exact paths and line ranges;
- identify the best starting file;
- coordinate with the supervisor when blocked or when a decision is required.

The scout may use `write` for an explicitly configured output artifact, but it must not modify project source files.

### Planner

Retain the custom profile's requirements for:

- approved outcomes and constraints;
- explicit non-goals;
- assumptions and unresolved decisions;
- YAGNI and bounded scope;
- no product-code implementation.

Add the builtin prompt's stronger requirements for:

- reading supplied context before planning;
- concrete ordered tasks;
- exact files and changes;
- acceptance and validation per task;
- dependencies and risks;
- surfacing ambiguity instead of guessing;
- supervisor coordination when approval or clarification is required.

When `writing-plans` is injected, that skill governs the detailed plan format, dated destination, TDD steps, self-review, and execution handoff. The base planner prompt must not duplicate the complete skill.

Do not set a default `output: plan.md`; the task or parent workflow must provide the authoritative plan path required by project instructions.

### Worker

Use the builtin worker prompt as the behavioral base because it has stronger approved-direction handling, decision escalation, progress coordination, no-false-success rules, and implementation handoff requirements.

Preserve the custom profile's:

- Superpowers workflow positioning;
- single-writer boundary;
- smallest-correct-change requirement;
- project-pattern and YAGNI constraints;
- real edit/write tool requirement;
- mechanical-worker selection belongs to the parent dispatch policy for exact deterministic edits and must not appear as worker self-routing guidance.

The worker must report changed files, validation commands and results, residual risks, work left undone, and decisions needing parent approval. It must not claim successful implementation when an edit task made no edits.

### Reviewer

Use the custom reviewer prompt as the behavioral base because it better matches project policy and Superpowers review templates.

Preserve:

- `defaultContext: fresh`;
- read-only source/worktree behavior;
- canonical `reviewer` routing for legacy `code-reviewer` requests;
- direct inspection rather than trusting parent or worker summaries;
- explicit Base/Head diff handling;
- Critical, Important, and Minor calibration;
- file/line evidence requirements;
- strengths, recommendations, and merge/readiness verdicts;
- test-value and scope review expectations.

Add the builtin prompt's:

- `progress.md` scratch-file policy;
- rule that review-only instructions beat progress-writing instructions;
- safe supervisor/intercom coordination behavior;
- explicit instruction not to invent findings and to say plainly when the review is clean.

Do not add `edit` or project-source `write` tools. Review fixes remain a separate single-writer worker task.

## Superpowers Skill Routing

The parent orchestration instructions in `AGENTS.md` will define these rules:

- **Planner:** pass `writing-plans` when delegating creation of a Superpowers implementation plan.
- **Worker for production behavior, bug fixes, reusable logic, parsing, API contracts, error handling, security, or regressions:** pass both `test-driven-development` and `verification-before-completion`.
- **Worker for static config, documentation, dependency pins, or other Testing Value Gate exclusions:** do not force TDD; require the appropriate direct verification and pass `verification-before-completion` when the worker owns completion evidence.
- **Reviewer:** provide the Superpowers review-template context in the task contract and use `context: "fresh"`; do not rely on broad skill inheritance.
- **Scout:** no default Superpowers skill is required.
- **All roles:** explicitly injected skills must be read and followed before role work begins.

This policy avoids loading every installed skill into every child while making required workflow skills explicit and reviewable at dispatch sites.

## Nix and Settings Integration

No new Nix resource mechanism is required. The existing package and Home Manager paths already package and recursively merge `settings.json`.

Implementation changes:

1. Add `subagents.agentOverrides` to the repository root `settings.json`.
2. Remove `model` and `thinking` from `agents/scout.md`, `agents/planner.md`, `agents/worker.md`, and `agents/reviewer.md` so settings can fill those fields.
3. Merge the approved hybrid prompt content into those four files.
4. Set tools, prompt mode, project context, skill discovery, and default context exactly as defined in the Frontmatter Contract.
5. Update `agents/README.md` to describe hybrid role profiles, settings-owned model routing, and explicit skill injection.
6. Update `AGENTS.md` with the Superpowers skill-routing contract for subagent dispatches.
7. Keep `mechanical-worker.md` and the disabled `code-reviewer.md` compatibility profile unchanged unless implementation inspection finds a direct conflict with this design.

Home Manager users may still override any routing entry through `programs.roche-pi.settings.subagents.agentOverrides`; the existing recursive merge keeps unrelated defaults intact.

## Validation

Do not add automated tests that merely assert static JSON, Markdown frontmatter, or prompt text. Validate behavior directly:

1. Build `.#packages.x86_64-linux.pi-config`.
2. Inspect the built `settings.json` to confirm all eight overrides and unrelated settings are preserved.
3. Inspect the built custom agent frontmatter to confirm `model` and `thinking` are absent and the intended context/tool boundaries remain.
4. Run pi-subagents discovery/model diagnostics against a temporary Pi home backed by the built package.
5. Confirm same-named custom agents resolve to the settings-provided GPT-5.6 model and thinking levels.
6. Confirm builtin-only roles resolve to their settings overrides.
7. Confirm an explicitly injected Superpowers skill remains available while `inheritSkills: false` prevents broad discovery.
8. Run the runtime extension-load check:

   ```sh
   nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
   ```

9. Run the full flake check:

   ```sh
   nix flake check --accept-flake-config --print-build-logs
   ```

## Non-Goals

- Do not modify pi-subagents source or its bundled builtin profiles.
- Do not enable broad inherited skill discovery for ordinary child agents.
- Do not give the reviewer source-editing authority.
- Do not add model fallbacks or enforce a model scope in this change.
- Do not change the current parent-session default model.
- Do not redesign `mechanical-worker` or introduce additional role names.
- Do not add tests that lock prompt prose or static configuration text.
