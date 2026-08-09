# Per-launch Pi skill-suite selection design

## Status

Approved in conversation and reviewed on 2026-08-09.

## Problem

The generated Pi settings always load the pinned Superpowers repository as a package. That package contributes both its skills and `.pi/extensions/superpowers.ts`, which adds the Superpowers bootstrap instructions.

The global `AGENTS.md` and several project-owned Pi subagent profiles also refer directly to Superpowers skills. Adding Matt Pocock's skills through another directory would therefore be additive rather than a clean replacement: both suites could load, the Superpowers extension could remain active, and Matt mode could still tell subagents to use missing Superpowers skills.

The user wants to keep the same `pi` command and choose the workflow suite independently for each launch. Authentication, sessions, settings, common extensions, project skills, themes, models, trust state, and other Pi behavior must remain shared.

## Goals

- Keep plain `pi` behavior on Superpowers by default.
- Select Matt mode for one launch with:

  ```sh
  ROCHE_PI_SKILLSET=matt pi
  ```

- Provide `pi-matt` as a fixed Matt convenience command while keeping `pi` plus `ROCHE_PI_SKILLSET` as the canonical selector interface.
- Load exactly one workflow suite per launch.
- Select the suite's skills, bootstrap/routing instructions, and compatible subagent behavior together.
- Keep the existing Pi configuration directory and mutable state unchanged.
- Pin both upstream repositories through Nix; do not clone or install them at Pi runtime.
- Load only Matt's stable `engineering` and `productivity` skill groups by default.
- Preserve the current single-writer, fresh-reviewer, explicit-skill, and parent-orchestration safety rules.

## Non-goals

- Loading both workflow suites in one session.
- Accepting arbitrary skill directories or Git URLs from the selector variable.
- Switching suites inside an already-running Pi process.
- Replacing project-local skills or package-provided skills such as `context-mode`, `pi-subagents`, or `intervals-time-entries`.
- Loading Matt's `in-progress` or `misc` skills by default.
- Reworking model selection, authentication, session storage, or project trust.
- Exposing the Matt selector inside jailed Pi environments; jailed Pi keeps the default Superpowers suite.

## User interface

The canonical installed executable remains named `pi`.

```sh
# Default
pi
ROCHE_PI_SKILLSET=superpowers pi

# Alternate suite for this process only
ROCHE_PI_SKILLSET=matt pi

# Fixed Matt convenience command
pi-matt
```

`ROCHE_PI_SKILLSET` accepts only `superpowers` and `matt`. An unset or empty value means `superpowers`. Any other value exits with status 2 and prints the accepted values.

`pi-matt` is a fixed convenience executable for normal Matt launches. It ignores `ROCHE_PI_SKILLSET`, including `ROCHE_PI_SKILLSET=superpowers`, and otherwise forwards arguments through the same wrapper logic as `pi`. It uses the same `~/.pi/agent` state. The environment-variable form remains the canonical selector contract.

Pi 0.83 has no skills-directory environment variable. `ROCHE_PI_SKILLSET` is a roche-pi wrapper contract, not a Pi environment variable.

## Architecture

### Pinned suite packages

`nix/packages/pi-deps.nix` continues to fetch Superpowers at a pinned revision and hash. It also fetches `mattpocock/skills` at a pinned commit and hash.

Superpowers remains a complete Pi package. Its manifest loads both `skills/` and `.pi/extensions/superpowers.ts`; the wrapper must load the package root rather than only its skills directory.

A small Nix derivation constructs the Matt runtime package. It contains only:

- `skills/engineering/`
- `skills/productivity/`

The package uses Pi's conventional top-level `skills/` discovery. Matt's repository has no runtime dependencies needed for skill loading, so the fetched source does not require `buildNpmPackage`.

Neither suite is present in the generated persistent `settings.packages` list. This prevents duplicate loading and lets the wrapper select exactly one suite with Pi's per-run `--extension`/`-e` package option.

### Pi wrapper

A Nix-built wrapper replaces the upstream Pi executable in `home.packages` while retaining the command name `pi`. The shared constructor accepts an executable name, a default suite, and whether environment selection is allowed. It calls the pinned upstream Pi binary after selecting a fixed suite definition.

The package outputs use that constructor three ways:

- `pi` keeps the `pi` executable name, defaults to Superpowers, and allows `ROCHE_PI_SKILLSET` selection;
- `pi-matt` installs the `pi-matt` executable, fixes the suite to Matt, and ignores `ROCHE_PI_SKILLSET`;
- `pi-superpowers` retains a `pi` executable fixed to Superpowers for jailed launchers and is not installed beside the main `pi` command.

Each suite definition contains:

- the immutable package root passed through `-e`;
- the immutable suite-routing prompt appended with `--append-system-prompt`.

The wrapper adds those arguments for normal interactive, print, JSON, and RPC launches, then forwards all user arguments unchanged.

Commands that manage or inspect Pi itself bypass suite injection:

- `install`
- `remove`
- `uninstall`
- `update`
- `list`
- `config`
- `auth`
- `--help`
- `--version`
- `--list-models [search]`

This keeps package management, model listing, and help output independent of the selected workflow suite.

The selector maps an enum to Nix store paths. It never evaluates the environment value as a path or shell fragment.

### Common and suite-specific instructions

The root `AGENTS.md` becomes suite-neutral. It retains shared project rules, including:

- task-specific worktree isolation for plans, specs, and implementation;
- plan/spec destinations;
- branch completion policy;
- the Testing Value Gate;
- Pi runtime verification requirements;
- parent-owned subagent orchestration and one-writer safety;
- clear-writing rules.

Direct references to Superpowers skill names move into a Superpowers routing prompt. That prompt preserves the current behavior for planning, TDD, verification, debugging, review adaptation, and explicit child skill injection.

A Matt routing prompt adapts Matt's workflows to Pi and `pi-subagents`:

- The parent session owns orchestration.
- Ordinary children do not launch subagents.
- `research` maps to an asynchronous `researcher` child.
- `code-review` maps to two parallel fresh-context `reviewer` children: one Standards review and one Spec review. The parent supplies the evidence required by Matt's skill and synthesizes both results.
- `implement` maps to one writer, followed by review. The writer receives `tdd` explicitly when the Testing Value Gate and approved seam call for test-first work.
- `to-spec` and `to-tickets` remain user-invoked workflows. The parent follows them directly unless the task explicitly delegates a concrete planning artifact.
- If required `docs/agents/*.md` setup files are absent, the agent asks the user to run `setup-matt-pocock-skills`; it does not silently invent issue-tracker or documentation settings.
- The canonical Pi review child remains `reviewer`; no `code-reviewer` agent is dispatched.

Suite routing is appended at startup, so the selected rules apply only to that Pi process.

### Shared suite-neutral subagent profiles

The project keeps one set of Pi agent files. The profiles become compatible with either suite rather than being copied per suite.

- `planner` creates concrete plans from approved requirements and follows any explicitly injected planning skill. It does not name `writing-plans` as a permanent dependency.
- `worker` remains the sole writer. It follows any explicitly injected TDD or implementation skill and reports fresh validation evidence without naming a Superpowers-only skill.
- `reviewer` remains fresh-context and read-only. Its generic contract supports Matt's Standards and Spec review tasks as well as ordinary code, plan, and solution reviews.
- `scout` and `mechanical-worker` retain their suite-neutral behavior.
- The disabled legacy `code-reviewer` shim points callers to `reviewer` without embedding Superpowers-only workflow instructions.
- `agents/README.md` documents the shared profile model rather than labeling all profiles as Superpowers profiles.

The profiles keep `inheritSkills: false`. The parent passes only the skill required by a concrete child task.

## Launch data flow

1. The shell starts selectable `pi`, optionally setting `ROCHE_PI_SKILLSET`, or starts fixed `pi-matt`.
2. The wrapper validates the selector for `pi`; `pi-matt` ignores the selector variable and chooses Matt. Both choose one immutable suite definition.
3. The wrapper starts upstream Pi with the selected package and routing prompt.
4. Pi loads common settings, packages, extensions, local skills, themes, and context from the existing `~/.pi/agent` directory.
5. Pi adds the selected per-run package:
   - Superpowers loads its skills and bootstrap extension; or
   - Matt loads the filtered stable skills package.
6. Pi appends the selected routing instructions.
7. `pi-subagents` discovers the shared suite-neutral agent profiles.
8. The parent maps suite workflows to concrete child tasks and injects only the needed skills.

No mutable files or symlinks change during launch, so concurrent Pi sessions may use different suites safely.

## Error handling

- An unknown selector passed to selectable `pi` fails before Pi starts, with the invalid value and accepted values in the message. Fixed `pi-matt` ignores the selector variable.
- Missing or changed upstream paths fail during the Nix build rather than at Pi startup.
- A Matt repository layout change that removes an expected stable skill directory fails package construction or its Nix check.
- The wrapper uses fixed argument arrays and quoted store paths so user arguments and prompt text cannot be reinterpreted by the shell.
- Persistent settings must not also include either suite. Verification checks for duplicate package wiring.

## Testing and verification

The wrapper contains reusable selection and argument-forwarding behavior, so automated tests pass the Testing Value Gate.

Add a Nix check using a fake upstream Pi executable to verify:

- an unset selector chooses Superpowers;
- explicit `superpowers` chooses Superpowers;
- `matt` chooses the Matt package and prompt;
- unknown values exit 2;
- user arguments retain their order and values;
- management, help, and `--list-models` inspection commands bypass suite injection;
- the `pi-matt` executable exists, fixes normal launches to Matt even when `ROCHE_PI_SKILLSET=superpowers`, forwards arguments unchanged, and shares the same bypass behavior.

Add runtime checks using the real Pi package to verify:

- Superpowers starts through the Home Manager-like resource layout without extension-loading failures;
- the Superpowers extension injects its `superpowers:using-superpowers bootstrap for pi` context marker before a test-only hook aborts the provider request;
- Matt starts through the same layout without loading the Superpowers extension;
- `pi-matt` exposes exactly the same resources as `ROCHE_PI_SKILLSET=matt pi` even when the environment requests Superpowers;
- the expected suite skills are discoverable and a representative skill from the other suite is absent;
- common extensions still load in both modes.

Final verification must include:

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
```

Static revision, hash, and documentation changes do not need tests of their literal values. Nix fetch/build evaluation and the runtime checks provide the relevant verification.

## Migration and compatibility

- Default `pi` launches remain on Superpowers, so existing command behavior does not change unless the selector is set. Invoking `pi-matt` explicitly selects Matt.
- Existing authentication, trust, model cache, run history, and sessions remain under `~/.pi/agent`.
- Home Manager and the default development shell install selectable `pi` and fixed `pi-matt` instead of the upstream executable. Both delegate Pi behavior after applying their suite-selection contract.
- Jailed Pi uses the fixed Superpowers wrapper; it installs no `pi-matt` command and does not forward `ROCHE_PI_SKILLSET` in this change.
- Internal checks may call the upstream executable only when they intentionally test Pi without a workflow suite. Profile and Home Manager-like startup checks call the applicable wrapper explicitly.
- Existing project shell and jailed-Pi resource wiring continue to use the shared suite-neutral agents.

## Alternatives rejected

### Two `PI_CODING_AGENT_DIR` trees

This uses a native Pi variable but duplicates or cross-links settings, authentication, trust, model caches, run history, sessions, extensions, and other mutable state. It changes much more than the workflow suite and is harder to keep consistent.

### Swap a global skills symlink

Mutating a shared symlink is unsafe for concurrent sessions and can leave the wrong suite selected after an interrupted command. It also fails to toggle the Superpowers extension and routing instructions.

### `--no-skills` with one explicit directory

This removes unrelated package and project skills, and loading only `superpowers/skills` omits the Superpowers bootstrap extension.

### Install both suites and use `pi config`

This makes a Home Manager-managed setting mutable, risks conflicting instructions, and requires disabling both the Superpowers skills and extension correctly on every switch.
