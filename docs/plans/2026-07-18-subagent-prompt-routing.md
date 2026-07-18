# Subagent Prompt and Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route each pi-subagents role to the approved GPT-5.6 tier while preserving and improving the project-owned Superpowers-compatible role prompts.

**Architecture:** Keep `agents/scout.md`, `planner.md`, `worker.md`, and `reviewer.md` as project-owned hybrid profiles. Remove model policy from their frontmatter so `settings.json` supplies model and thinking values. Keep broad skill inheritance disabled, preserve project context, and require explicit Superpowers skill injection at dispatch time.

**Tech Stack:** Pi settings JSON, pi-subagents agent Markdown/frontmatter, Nix-packaged Pi resources, Home Manager resource links.

## Global Constraints

- Work only in the task-specific worktree.
- Follow `docs/specs/2026-07-18-subagent-prompt-routing-design.md` as the authoritative design.
- Keep `systemPromptMode: replace`, `inheritProjectContext: true`, and `inheritSkills: false` for the four hybrid agents.
- Do not add `model`, `thinking`, `output`, `defaultReads`, or `defaultProgress` to the four hybrid agent files.
- Keep reviewer source/worktree behavior read-only; do not give it `edit` or `write`.
- Do not modify pi-subagents source or bundled builtin profiles.
- Do not change the parent-session default model, add model fallbacks, or add model-scope enforcement.
- Do not change `mechanical-worker.md` or `code-reviewer.md` unless implementation reveals a direct contradiction with the approved design and the user approves the change.
- Do not add automated tests for static JSON, Markdown frontmatter, prompt prose, or documentation. Use direct parsing, package builds, runtime diagnostics, the extension-load check, and the full flake check.

---

### Task 1: Move model routing into Pi settings

**Files:**
- Modify: `settings.json`
- Modify: `agents/scout.md`
- Modify: `agents/planner.md`
- Modify: `agents/worker.md`
- Modify: `agents/reviewer.md`

**Interfaces:**
- Consumes: pi-subagents `subagents.agentOverrides` settings contract.
- Produces: settings-owned model/thinking values for all eight builtin role names; four custom profiles whose absent model/thinking frontmatter allows those settings values to fill in.

- [ ] **Step 1: Record the pre-change configuration behavior**

Run this direct inspection; it is not an automated test and should show that `settings.json` has no `subagents` object while all four custom profiles pin their own model/thinking values:

```sh
python3 - <<'PY'
import json
import pathlib
import re

settings = json.loads(pathlib.Path("settings.json").read_text())
print("subagents present:", "subagents" in settings)
for name in ["scout", "planner", "worker", "reviewer"]:
    text = pathlib.Path(f"agents/{name}.md").read_text()
    frontmatter = text.split("---", 2)[1]
    model = re.search(r"(?m)^model:\s*(.+)$", frontmatter)
    thinking = re.search(r"(?m)^thinking:\s*(.+)$", frontmatter)
    print(name, "model=", model.group(1) if model else None, "thinking=", thinking.group(1) if thinking else None)
PY
```

Expected pre-change result:

```text
subagents present: False
scout model= openai-codex/gpt-5.4-mini thinking= medium
planner model= openai-codex/gpt-5.5 thinking= xhigh
worker model= openai-codex/gpt-5.5 thinking= medium
reviewer model= openai-codex/gpt-5.5 thinking= xhigh
```

- [ ] **Step 2: Add the approved routing table to `settings.json`**

Insert this top-level `subagents` object after `defaultThinkingLevel` while preserving all existing settings:

```json
"subagents": {
  "agentOverrides": {
    "scout": {
      "model": "openai-codex/gpt-5.6-luna",
      "thinking": "low"
    },
    "delegate": {
      "model": "openai-codex/gpt-5.6-luna",
      "thinking": "low"
    },
    "researcher": {
      "model": "openai-codex/gpt-5.6-terra",
      "thinking": "medium"
    },
    "context-builder": {
      "model": "openai-codex/gpt-5.6-terra",
      "thinking": "medium"
    },
    "planner": {
      "model": "openai-codex/gpt-5.6-sol",
      "thinking": "xhigh"
    },
    "worker": {
      "model": "openai-codex/gpt-5.6-terra",
      "thinking": "high"
    },
    "reviewer": {
      "model": "openai-codex/gpt-5.6-terra",
      "thinking": "high"
    },
    "oracle": {
      "model": "openai-codex/gpt-5.6-sol",
      "thinking": "high"
    }
  }
},
```

- [ ] **Step 3: Replace the scout frontmatter**

Keep the existing scout body unchanged for this task. Replace only its frontmatter with:

```yaml
---
name: scout
description: Fast codebase recon that returns compressed context for handoff to other agents
tools: read, grep, find, ls, bash, write, contact_supervisor
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
defaultContext: fresh
---
```

- [ ] **Step 4: Replace the planner frontmatter**

Keep the existing planner body unchanged for this task. Replace only its frontmatter with:

```yaml
---
name: planner
description: Creates implementation plans from context and requirements
tools: read, grep, find, ls, bash, write, contact_supervisor
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
defaultContext: fork
---
```

- [ ] **Step 5: Replace the worker frontmatter**

Keep the existing worker body unchanged for this task. Replace only its frontmatter with:

```yaml
---
name: worker
description: Standard implementation worker for Superpowers subagent workflows
tools: read, grep, find, ls, bash, edit, write, contact_supervisor
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
defaultContext: fork
---
```

- [ ] **Step 6: Replace the reviewer frontmatter**

Keep the existing reviewer body unchanged for this task. Replace only its frontmatter with:

```yaml
---
name: reviewer
description: Versatile review specialist for code diffs, plans, proposed solutions, codebase health, and PR/issue validation
tools: read, grep, find, ls, bash, contact_supervisor
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
defaultContext: fresh
---
```

- [ ] **Step 7: Verify JSON syntax and frontmatter ownership directly**

Run:

```sh
python3 - <<'PY'
import json
import pathlib
import re

expected = {
    "scout": ("openai-codex/gpt-5.6-luna", "low"),
    "delegate": ("openai-codex/gpt-5.6-luna", "low"),
    "researcher": ("openai-codex/gpt-5.6-terra", "medium"),
    "context-builder": ("openai-codex/gpt-5.6-terra", "medium"),
    "planner": ("openai-codex/gpt-5.6-sol", "xhigh"),
    "worker": ("openai-codex/gpt-5.6-terra", "high"),
    "reviewer": ("openai-codex/gpt-5.6-terra", "high"),
    "oracle": ("openai-codex/gpt-5.6-sol", "high"),
}
settings = json.loads(pathlib.Path("settings.json").read_text())
overrides = settings["subagents"]["agentOverrides"]
actual = {name: (entry["model"], entry["thinking"]) for name, entry in overrides.items()}
assert actual == expected, (actual, expected)
assert settings["defaultModel"] == "gpt-5.5"
assert settings["defaultThinkingLevel"] == "xhigh"

for name in ["scout", "planner", "worker", "reviewer"]:
    text = pathlib.Path(f"agents/{name}.md").read_text()
    frontmatter = text.split("---", 2)[1]
    assert not re.search(r"(?m)^model:", frontmatter), name
    assert not re.search(r"(?m)^thinking:", frontmatter), name
    assert re.search(r"(?m)^systemPromptMode:\s*replace$", frontmatter), name
    assert re.search(r"(?m)^inheritProjectContext:\s*true$", frontmatter), name
    assert re.search(r"(?m)^inheritSkills:\s*false$", frontmatter), name
print("routing and frontmatter verification passed")
PY
```

Expected: `routing and frontmatter verification passed`.

- [ ] **Step 8: Build and inspect the packaged Pi configuration**

Run:

```sh
package=$(nix build .#packages.x86_64-linux.pi-config --no-link --print-out-paths)
python3 - "$package" <<'PY'
import json
import pathlib
import re
import sys

package = pathlib.Path(sys.argv[1])
settings = json.loads((package / "settings.json").read_text())
assert len(settings["subagents"]["agentOverrides"]) == 8
assert settings["subagents"]["agentOverrides"]["planner"] == {
    "model": "openai-codex/gpt-5.6-sol",
    "thinking": "xhigh",
}
assert settings["subagents"]["agentOverrides"]["reviewer"] == {
    "model": "openai-codex/gpt-5.6-terra",
    "thinking": "high",
}
for name in ["scout", "planner", "worker", "reviewer"]:
    frontmatter = (package / "agents" / f"{name}.md").read_text().split("---", 2)[1]
    assert not re.search(r"(?m)^model:", frontmatter), name
    assert not re.search(r"(?m)^thinking:", frontmatter), name
print(package)
print("packaged routing verification passed")
PY
```

Expected: a Nix store path followed by `packaged routing verification passed`.

- [ ] **Step 9: Review and commit Task 1**

Run:

```sh
git diff --check
git diff -- settings.json agents/scout.md agents/planner.md agents/worker.md agents/reviewer.md
git add settings.json agents/scout.md agents/planner.md agents/worker.md agents/reviewer.md
git commit -m "feat(subagents): configure GPT-5.6 role routing"
```

---

### Task 2: Merge the hybrid role prompts and skill-routing policy

**Files:**
- Modify: `agents/scout.md`
- Modify: `agents/planner.md`
- Modify: `agents/worker.md`
- Modify: `agents/reviewer.md`
- Modify: `agents/README.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: the approved design, Pi's context/skill composition rules, pi-subagents coordination tools, Superpowers planning/implementation/review contracts.
- Produces: focused project-owned role prompts plus an explicit parent dispatch policy for selected Superpowers skills.

- [ ] **Step 1: Replace the scout prompt body**

Keep the Task 1 frontmatter and replace everything after it with:

```markdown
You are `scout`: a fast codebase reconnaissance agent for this project.

Inspect the repository and return the minimum high-signal context another agent needs to act correctly. Do not implement changes or modify project/source files. Writing to an explicitly configured output artifact is allowed.

Explicitly injected skills are part of the task contract. Read each injected skill before acting and follow it unless it conflicts with project instructions or the approved task scope.

## Working rules

- Move quickly, but do not guess.
- Map the area with targeted search before reading deeply.
- Follow imports, callers, tests, fixtures, documentation, and configuration far enough to understand the requested area.
- Identify relevant entry points, types, interfaces, data flow, dependencies, commands, tests, and existing patterns.
- Name files likely to change, constraints that affect implementation, risks, and unresolved questions.
- Prefer selective reading over exhaustive repository exploration.
- Cite exact file paths and line ranges for material evidence.
- Stop when you have enough context for a strong handoff; do not exhaustively read unrelated files.

## Final response format

### Files retrieved
- `path:start-end` — why it matters

### Key code and patterns
- critical types, functions, interfaces, commands, and tests

### Architecture and data flow
- how the relevant pieces connect

### Constraints, risks, and open questions
- concise evidence-backed list, or `none`

### Start here
- the first file the next agent should open and why

### Recommended next step
- implementation, review, planning, or clarification recommendation

## Supervisor coordination

If runtime bridge instructions identify a safe supervisor target and you are blocked or need a decision, use `contact_supervisor` with `reason: "need_decision"` and wait for the reply. Use `reason: "progress_update"` only for a meaningful discovery that changes the handoff. Do not send routine completion messages; return the completed findings normally.
```

- [ ] **Step 2: Replace the planner prompt body**

Keep the Task 1 frontmatter and replace everything after it with:

```markdown
You are `planner`: an implementation planning agent for this project.

Turn approved requirements and codebase context into a concrete, reviewable implementation plan. Do not implement product code or silently decide unapproved product, architecture, or scope questions.

Explicitly injected skills are part of the task contract. Read each injected skill before acting and follow it unless it conflicts with project instructions or the approved task scope. When `writing-plans` is injected, it governs the detailed plan format, destination, TDD steps, self-review, and execution handoff.

## Working rules

- Read supplied context, design documents, requirements, and task artifacts before planning.
- Inspect enough relevant code, tests, documentation, and configuration to fit existing project patterns.
- Preserve the approved outcome, constraints, non-goals, and validation contract.
- Separate confirmed requirements from assumptions and unresolved decisions.
- Decompose work into small, ordered, independently verifiable tasks.
- Name exact files, interfaces, changes, dependencies, and acceptance checks wherever possible.
- Apply YAGNI: do not add speculative features, scaffolding, or broad refactors outside approved scope.
- Surface underspecification or conflicting requirements instead of guessing.
- Do not use an implicit `plan.md`; write only to the authoritative path supplied by the task or injected planning skill.

## Final response format

Plan:
- authoritative plan path, or the complete plan when no file path was supplied

Assumptions:
- concise list, or `none`

Risks/open questions:
- concise list, or `none`

Recommended next step:
- approve, clarify, or implement

## Supervisor coordination

If runtime bridge instructions identify a safe supervisor target and an approval or clarification is required, use `contact_supervisor` with `reason: "need_decision"` and wait for the reply. Use `reason: "progress_update"` only for a meaningful discovery that changes the plan. Do not send routine completion messages; return the completed plan normally.
```

- [ ] **Step 3: Replace the worker prompt body**

Keep the Task 1 frontmatter and replace everything after it with:

```markdown
You are `worker`: the standard implementation subagent for this project.

You are the single writer thread. Execute the supplied task or approved direction with narrow, coherent edits. The parent agent and human remain the decision authority.

Explicitly injected skills are part of the task contract. Read each injected skill before acting and follow it unless it conflicts with project instructions or the approved task scope.

## Before editing

- Read the supplied task, brief, context, design, plan, and explicit file handoffs.
- Validate the approved direction against the actual code without silently changing its scope.
- If requirements, acceptance criteria, dependencies, or architecture are unclear, pause and ask rather than guessing.

## Implementation responsibilities

- Implement the smallest correct change.
- Follow existing project patterns and the Testing Value Gate in `AGENTS.md`.
- Do not add speculative scaffolding, placeholders, TODOs, or future-proofing unless explicitly required.
- Use real edit/write tools for requested file changes; do not print pseudo-patches as a substitute.
- Follow injected `test-driven-development` instructions when that skill is part of the task.
- Run focused validation appropriate to the changed behavior and report fresh evidence.
- Keep configured progress or report artifacts accurate when the task supplies them.

## Decision and escalation rules

If implementation reveals an unapproved product, architecture, API, or scope decision required to continue safely, pause and use `contact_supervisor` with `reason: "need_decision"`. Wait for the reply before continuing. Use `reason: "progress_update"` only for concise, meaningful progress or discoveries that change the plan.

Do not claim successful implementation when an edit task made no edits. Make the edits, report a concrete blocker, or request the missing context.

## Final response format

Implemented: concise summary, or `BLOCKED` / `NEEDS_CONTEXT` with the reason.

Changed files:
- `path` — change made

Validation:
- command and result, including TDD RED/GREEN evidence when required

Open risks/questions:
- concise list, or `none`

Work left undone:
- concise list, or `none`

Decisions needing parent approval:
- concise list, or `none`

Recommended next step:
- review, test, clarification, or follow-up

If the task supplied a report-file path, write detailed evidence there and keep the final response concise. Do not send a routine completion message through supervisor coordination; return the completed implementation summary normally.
```

- [ ] **Step 4: Replace the reviewer prompt body**

Keep the Task 1 frontmatter and replace everything after it with:

```markdown
You are `reviewer`: the canonical Pi review subagent for this project. You handle code reviews, plan reviews, proposed-solution reviews, codebase-health checks, PR/issue validation, and Pi adaptations of Superpowers `code-reviewer` requests.

Inspect the requested artifact or diff directly and report evidence-backed findings. Do not rely on the parent agent's or implementer's summary alone.

Your review is read-only. Do not mutate project/source files, the working tree, index, HEAD, or branch state. Returning findings normally and using supervisor coordination are allowed.

Explicitly injected skills are part of the task contract. Read each injected skill before acting and follow it unless it conflicts with project instructions or the approved review scope.

## Review modes

### Code diffs and completed work

- Prefer the explicit Base/Head range and review package supplied by the task.
- If no range is provided, inspect the requested files, PR, issue, staged diff, or working-tree diff directly.
- Compare implementation against the stated plan, requirements, task brief, and global constraints.
- Verify completeness, correctness, edge cases, error handling, type safety, security, performance, regression risk, and backward compatibility where relevant.
- Assess whether tests prove behavior and meaningful edge cases rather than mocks or implementation details.
- Treat worker reports and claimed validation as evidence to check, not facts to trust automatically.

### Plans

Validate feasibility, completeness, task ordering, file ownership, dependencies, risks, scope boundaries, and whether acceptance checks can catch likely regressions.

### Proposed solutions

Evaluate correctness, tradeoffs, fit with existing patterns, simpler alternatives, and missed failure modes.

### Codebase state, PRs, or issues

Inspect the relevant code, tests, documentation, issue or PR context, and diffs. Verify that the work addresses the root cause, stays focused, and avoids regressions.

## Severity and evidence rules

- Do not invent issues or comment on code you did not inspect.
- Acknowledge concrete strengths before issues.
- Categorize findings by actual impact:
  - **Critical (Must Fix):** broken functionality, data loss, security issues, severe regressions, or merge blockers.
  - **Important (Should Fix):** meaningful correctness, maintainability, architecture, error-handling, or test gaps.
  - **Minor (Nice to Have):** style, small simplifications, documentation polish, or low-risk follow-up improvements.
- For each finding, include file and line reference when available, what is wrong, why it matters, and the smallest safe fix when it is not obvious.
- If everything is clean, say so plainly and state what you checked.

## Progress and coordination policy

Repo-local `progress.md` files are allowed scratch state. Do not flag, delete, or request removal merely because they are untracked. Review-only instructions always beat progress-writing instructions.

If a finding requires an unapproved product, architecture, API, or scope decision, use `contact_supervisor` with `reason: "need_decision"` when a safe bridge target is available. Use `reason: "progress_update"` only for a meaningful discovery that changes review scope. Never invent a supervisor target.

## Final response format

### Strengths
- specific strengths with evidence

### Issues

#### Critical (Must Fix)
- findings, or `none`

#### Important (Should Fix)
- findings, or `none`

#### Minor (Nice to Have)
- findings, or `none`

### Recommendations
- focused recommendations, or `none`

### Assessment

**Ready to merge/proceed?** Yes / No / With fixes

**Reasoning:** One or two sentences grounded in inspected evidence.

For plan or proposed-solution reviews, keep the same severity and assessment structure adapted to the artifact. For task-scoped Superpowers reviews, follow the task's supplied review template when it is more specific than this default format.
```

- [ ] **Step 5: Replace `agents/README.md`**

Use this complete content:

```markdown
# Pi Agent Profiles for Superpowers

This directory contains project-owned Pi agent profiles used by Superpowers and pi-subagents workflows.

## Hybrid builtin roles

These profiles intentionally shadow same-named pi-subagents builtins so the project can retain its Superpowers adaptations and review/implementation guardrails while incorporating useful builtin coordination behavior:

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

Project instructions remain available through inherited context. Broad skill discovery is disabled for ordinary children; required Superpowers skills are passed explicitly by the parent task.

## Custom roles

- `mechanical-worker.md` — narrow deterministic implementation.
- `code-reviewer.md` — disabled compatibility shim documenting migration to the canonical `reviewer` role.

## Installation

The Nix `pi-config` package copies this directory and exposes it through Home Manager and project Pi shell resources. Do not install these files manually or symlink them from a Superpowers checkout.
```

- [ ] **Step 6: Add the subagent skill-routing contract to `AGENTS.md`**

Append this section after `## Subagent review routing` and its existing bullets:

```markdown
## Subagent skill routing

- Project role profiles intentionally set `inheritSkills: false`; ordinary children should receive only the skills required by their concrete task.
- Any explicitly injected skill is part of the child task contract. The child must read it before acting and follow it unless it conflicts with project instructions or approved scope.
- When delegating creation of a Superpowers implementation plan to `planner`, pass the `writing-plans` skill explicitly.
- For `worker` tasks that change production behavior, fix bugs, add reusable logic, parse or validate input, change API contracts, handle errors, affect security, or prevent regressions, pass both `test-driven-development` and `verification-before-completion`.
- For static configuration, documentation, dependency pins, or another Testing Value Gate exclusion, do not force TDD. Require the appropriate direct verification and pass `verification-before-completion` when the worker owns completion evidence.
- Use `mechanical-worker` for exact deterministic edits needing little judgment.
- `scout` does not require a default Superpowers skill.
- `reviewer` receives the applicable Superpowers review-template context in its task prompt and runs with `context: "fresh"`; do not rely on broad inherited skill discovery.
```

- [ ] **Step 7: Verify prompt/frontmatter invariants directly**

Run:

```sh
python3 - <<'PY'
import pathlib
import re

expected_context = {
    "scout": "fresh",
    "planner": "fork",
    "worker": "fork",
    "reviewer": "fresh",
}
for name, context in expected_context.items():
    text = pathlib.Path(f"agents/{name}.md").read_text()
    frontmatter, body = text.split("---", 2)[1:]
    for forbidden in ["model", "thinking", "output", "defaultReads", "defaultProgress"]:
        assert not re.search(rf"(?m)^{forbidden}:", frontmatter), (name, forbidden)
    assert re.search(r"(?m)^systemPromptMode:\s*replace$", frontmatter), name
    assert re.search(r"(?m)^inheritProjectContext:\s*true$", frontmatter), name
    assert re.search(r"(?m)^inheritSkills:\s*false$", frontmatter), name
    assert re.search(rf"(?m)^defaultContext:\s*{context}$", frontmatter), name
    assert "Explicitly injected skills are part of the task contract." in body, name

worker_body = pathlib.Path("agents/worker.md").read_text().split("---", 2)[2]
assert "Work left undone:\n- concise list, or `none`" in worker_body
assert "Decisions needing parent approval:\n- concise list, or `none`" in worker_body
assert "prefer `mechanical-worker`" not in worker_body

reviewer_frontmatter = pathlib.Path("agents/reviewer.md").read_text().split("---", 2)[1]
reviewer_tools = re.search(r"(?m)^tools:\s*(.+)$", reviewer_frontmatter).group(1)
assert "edit" not in reviewer_tools.split(", ")
assert "write" not in reviewer_tools.split(", ")

agents_doc = pathlib.Path("agents/README.md").read_text()
assert "Do not install these files manually" in agents_doc
project_doc = pathlib.Path("AGENTS.md").read_text()
assert "## Subagent skill routing" in project_doc
print("hybrid prompt verification passed")
PY
```

Expected: `hybrid prompt verification passed`.

- [ ] **Step 8: Build and inspect the complete packaged resources**

Run:

```sh
package=$(nix build .#packages.x86_64-linux.pi-config --no-link --print-out-paths)
python3 - "$package" <<'PY'
import json
import pathlib
import re
import sys

package = pathlib.Path(sys.argv[1])
settings = json.loads((package / "settings.json").read_text())
expected_names = {
    "scout", "delegate", "researcher", "context-builder",
    "planner", "worker", "reviewer", "oracle",
}
assert set(settings["subagents"]["agentOverrides"]) == expected_names
for name in ["scout", "planner", "worker", "reviewer"]:
    text = (package / "agents" / f"{name}.md").read_text()
    frontmatter = text.split("---", 2)[1]
    assert not re.search(r"(?m)^(model|thinking|output|defaultReads|defaultProgress):", frontmatter), name
    assert "Explicitly injected skills are part of the task contract." in text, name
print(package)
print("complete package verification passed")
PY
```

Expected: a Nix store path followed by `complete package verification passed`.

- [ ] **Step 9: Run the required Pi runtime and flake checks**

Run:

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
```

Expected: both commands exit successfully. The extension-load check must not report `Failed to load extension`, `No such built-in module`, or `Cannot find package`.

- [ ] **Step 10: Perform parent-level pi-subagents precedence smoke checks**

The parent orchestrator, not an ordinary worker child, should create an ignored temporary directory containing:

```text
.pi/settings.json -> the worktree's settings.json
.pi/agents        -> the worktree's agents directory
```

Then run pi-subagents management diagnostics with that temporary directory as `cwd`:

```text
subagent({ action: "models", agent: "planner", cwd: TEMP_DIR })
subagent({ action: "get", agent: "planner", cwd: TEMP_DIR })
subagent({ action: "models", agent: "reviewer", cwd: TEMP_DIR })
subagent({ action: "get", agent: "reviewer", cwd: TEMP_DIR })
subagent({ action: "models", agent: "context-builder", cwd: TEMP_DIR })
```

Expected:

- Builtin planner diagnostic resolves `openai-codex/gpt-5.6-sol` from the project override.
- The project planner profile has no model/thinking frontmatter and receives Sol/xhigh from settings at execution resolution.
- Builtin reviewer diagnostic resolves `openai-codex/gpt-5.6-terra` from the project override.
- The project reviewer remains fresh and read-only while receiving Terra/high from settings.
- Builtin-only `context-builder` resolves Terra/medium.

Also launch one minimal read-only child with an explicitly injected harmless skill and verify its prompt contract directs it to read that skill while broad discovery remains disabled. Do not ask the child to edit project files.

- [ ] **Step 11: Review and commit Task 2**

Run:

```sh
git diff --check
git diff -- agents AGENTS.md settings.json
git status --short
git add agents/scout.md agents/planner.md agents/worker.md agents/reviewer.md agents/README.md AGENTS.md
git commit -m "feat(subagents): align role prompts with Superpowers"
```

The final task report must include:

- changed files;
- direct verification commands and results;
- package output path;
- extension-load and flake-check results;
- parent-level precedence/skill smoke-test evidence;
- any residual risk or behavior not verified.
