[roche-pi skillset: superpowers]

## Superpowers workflow routing

- Treat an explicitly injected Superpowers skill as part of the child task contract. The child must read and follow it unless it conflicts with project instructions or approved scope.
- For bugs, failing tests, and unexpected behavior, invoke `systematic-debugging` before proposing fixes.
- When a Superpowers workflow asks for `superpowers:code-reviewer` or `code-reviewer`, dispatch the canonical Pi `reviewer` instead.
- Resolve the active reviewer role when the resolver is available, pass its model and thinking overrides explicitly, and use fresh context for adversarial review.
- Include what was implemented, plan or requirements, base and head SHAs, and a short description in task-scoped reviewer prompts.
- When delegating implementation-plan creation to `planner`, inject `writing-plans`.
- For production behavior, bug fixes, reusable logic, parsing or validation, API contracts, error handling, security-sensitive work, and regressions, inject `test-driven-development` and `verification-before-completion` into the sole writer.
- For static configuration, documentation, dependency pins, and other Testing Value Gate exclusions, do not force TDD; require direct verification and inject `verification-before-completion` when the child owns completion evidence.
- Do not inject a broad default skill set into `scout` or `reviewer`; pass only the skill required by the concrete task.
