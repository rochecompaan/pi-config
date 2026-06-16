## Plans, specs and designs

- **Save plans to:** `docs/plans/YYYY-MM-DD-<feature-name>.md`
- Write the validated design (spec) to `docs/specs/YYYY-MM-DD-<topic>-design.md`
- Treat specs and plans as the start of a new feature: create or use a task-specific git worktree before writing them, just like implementation changes.
- If the task-specific worktree does not exist yet, create it with the `using-git-worktrees` skill before writing the spec or plan.

## Testing policy

Use automated tests by default for production behavior changes, bug fixes, reusable logic, parsing/validation, API contracts, error handling, security-sensitive behavior, and regressions.

Before writing a new test, apply a Testing Value Gate:

- Will this test prove behavior rather than restate implementation/config?
- Could it fail for a meaningful regression?
- Will future maintainers benefit from rerunning it?
- Is the behavior reusable or risky enough to justify test maintenance?

If the answer is no, do not write a new automated test. Use direct verification instead.

Do not write new tests merely to assert:

- GitHub Actions workflow YAML content
- dependency or requirements versions
- package lock contents
- static config values
- documentation text
- one-off script structure

For those cases, verify with the appropriate command instead, such as linting, syntax checks, dry-runs, builds, or existing test suites.

When skipping a new test, briefly state the verification used instead.

## Subagent review routing

- The canonical Pi review subagent is `reviewer`.
- Do not dispatch `code-reviewer`; legacy `code-reviewer` agents are disabled and only document the migration path.
- When a Superpowers skill or template says to dispatch `superpowers:code-reviewer` or `code-reviewer`, adapt it to Pi by dispatching `reviewer` instead.
- Before dispatching a review subagent, resolve the active reviewer role with `resolve_agent_team({ role: "reviewer" })` when available. Pass the resolved `model` and `thinking` explicitly when present.
- Use `context: "fresh"` for adversarial code review unless the user explicitly asks for forked context.
- Include the Superpowers code-review template context in the `reviewer` task prompt: what was implemented, plan or requirements, base/head SHAs, and a short description.
