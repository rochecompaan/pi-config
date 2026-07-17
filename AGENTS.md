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

## Pi and dependency update testing

After updating Pi itself, flake inputs, or packaged Pi dependencies, do not rely on `pi --help`, `pi list`, or Nix builds alone. Those checks can miss extension-loading failures.

Run the runtime extension-load check before declaring the update complete:

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Also run the full flake check:

```sh
nix flake check --accept-flake-config --print-build-logs
```

If the extension-load check is unavailable, manually test a Home Manager-like startup path: build `.#packages.x86_64-linux.pi-config`, create a temporary `HOME` with `~/.pi/agent` symlinked to the package resources, and run Pi in non-interactive prompt mode (for example `pi -p "Say ok" --no-tools --provider __invalid__`). The test must fail only at the expected provider/API-key stage; any `Failed to load extension`, `No such built-in module`, or `Cannot find package` error is a regression.

`pi-intervals` is maintained separately at `~/projects/pi/extensions/pi-intervals`. If `pi-intervals` breaks after a Pi or dependency update, prefer asking the user to fix it there and then bump the pinned revision in this repo. Do not patch `pi-intervals` source in this repo except as an explicit temporary workaround requested by the user.

## Subagent review routing

- The canonical Pi review subagent is `reviewer`.
- Do not dispatch `code-reviewer`; legacy `code-reviewer` agents are disabled and only document the migration path.
- When a Superpowers skill or template says to dispatch `superpowers:code-reviewer` or `code-reviewer`, adapt it to Pi by dispatching `reviewer` instead.
- Before dispatching a review subagent, resolve the active reviewer role with `resolve_agent_team({ role: "reviewer" })` when available. Pass the resolved `model` and `thinking` explicitly when present.
- Use `context: "fresh"` for adversarial code review unless the user explicitly asks for forked context.
- Include the Superpowers code-review template context in the `reviewer` task prompt: what was implemented, plan or requirements, base/head SHAs, and a short description.
