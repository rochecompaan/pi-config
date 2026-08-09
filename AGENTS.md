## Plans, specs and designs

- **Save plans to:** `docs/plans/YYYY-MM-DD-<feature-name>.md`
- Write the validated design (spec) to `docs/specs/YYYY-MM-DD-<topic>-design.md`
- Treat specs and plans as the start of a new feature: create or use a task-specific git worktree before writing them, just like implementation changes.
- If the task-specific worktree does not exist yet, create one before writing the spec or plan.

## Completing development work

- When presenting branch-completion options, offer to squash merge into `main` locally instead of offering a regular merge into `main`.
- When that option is selected, integrate the feature as one squash commit on `main`; preserve the feature branch's individual commits only when the user explicitly requests it.

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

- The canonical Pi review subagent is `reviewer`; do not dispatch the disabled `code-reviewer` compatibility shim.
- Resolve the active reviewer role when the resolver is available. Pass resolved model and thinking values explicitly when present.
- Use fresh context for adversarial review unless the user explicitly asks for inherited context.
- Give reviewers the artifact or diff, requirements, base and head references when relevant, acceptance criteria, and a concise task description.

## Subagent skill routing

- The parent Pi session owns orchestration. Ordinary child agents do not launch subagents or run their own orchestration loops.
- Keep exactly one writing child active in a shared checkout; parallel research and review roles remain read-only.
- Project role profiles intentionally set `inheritSkills: false`; ordinary children receive only the skills required by their concrete task.
- Any explicitly injected skill is part of the child task contract. The child must read it before acting and follow it unless it conflicts with project instructions or approved scope.
- The selected launch profile defines suite-specific skill names and workflow-to-subagent adaptations.
- Use `worker` for judgment-bearing implementation and `mechanical-worker` for exact deterministic edits needing little judgment.
- `scout` does not require a default skill.
- `reviewer` runs with fresh context for adversarial review and receives task-specific review instructions instead of broad inherited skill discovery.

## Rules for clear, readable writing

Apply these rules to explanatory prose, not code, identifiers, commands,
quotations, error messages, or text that must remain exact.

1. Prefer short, familiar words when they are equally precise.
2. Prefer plain language. Use technical terms when they are standard or more exact, and explain uncommon terms when useful.
3. Remove words that do not add meaning, but keep enough context to avoid ambiguity.
4. Prefer active voice when it makes the actor and action clearer. Use passive voice when it better serves the sentence.
5. Avoid clichés and stock figures of speech. Use comparisons only when they improve understanding.
6. Put accuracy first, clarity second, and brevity third. Break any rule that would make the writing less accurate, clear, natural, or useful.
