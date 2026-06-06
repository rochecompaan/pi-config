## Plans, specs and designs

- **Save plans to:** `docs/plans/YYYY-MM-DD-<feature-name>.md`
- Write the validated design (spec) to `docs/specs/YYYY-MM-DD-<topic>-design.md`

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
