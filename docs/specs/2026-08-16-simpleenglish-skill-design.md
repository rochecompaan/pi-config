# SimpleEnglish Skill Integration Design

**Date:** 2026-08-16

## Goal

Add [AminBlg/SimpleEnglish](https://github.com/AminBlg/SimpleEnglish) to the Nix-managed Pi configuration as a globally discoverable Agent Skill.

Pi must load the upstream `skills/simple-english/SKILL.md` only when its description matches a technical-writing task. The skill must be available through the shared Pi resource package for `pi`, `pi-matt`, jailed Pi, project Pi resources, and subagents that use the shared skill directory.

## Approved behavior

- Pin upstream release `v1.2.0` with a fixed Nix source hash.
- Install the complete upstream `skills/simple-english` directory, including its reference files.
- Expose the skill under the name `simple-english` in the packaged Pi skills directory.
- Use Pi's native `SKILL.md` discovery and task-trigger behavior.
- Keep the integration immutable and available without a runtime network request.
- Make the skill visible in both the Superpowers and Matt skill-set launch profiles.

## Non-goals

- Do not append SimpleEnglish instructions to `AGENTS.md`.
- Do not use the standalone prompt from `prompts/system-prompt.md`.
- Do not apply SimpleEnglish rules to every model call.
- Do not use `npx skills add` or another mutable runtime installer.
- Do not vendor upstream skill files into this repository.
- Do not add the repository as a Pi extension package path. SimpleEnglish is an Agent Skill, not a Pi extension.

## Architecture

### Pinned upstream source

`nix/packages/pi-deps.nix` will define a fixed-output source for the `v1.2.0` tag and export it as `simpleEnglishSrc`.

The source has no runtime package dependencies. A fetched source derivation is sufficient. The integration does not need `buildNpmPackage`.

### Pi skill resource

`modules/packages/pi-config.nix` will add a store symlink:

```text
${piConfig}/skills/simple-english
  -> ${simpleEnglishSrc}/skills/simple-english
```

The existing Pi configuration package already copies repository-owned skills into `${piConfig}/skills`. It also links external skills into that directory. The SimpleEnglish link will follow this pattern.

The linked directory contains:

- `SKILL.md`
- `references/checklist.md`
- `references/use-cases.md`

Relative references from `SKILL.md` will therefore remain valid.

### Launch-path propagation

The common Pi resource layer exports `${piConfig}/skills` through Home Manager, jailed Pi, and project Pi resources. Both skill-set wrappers use the same agent resource directory. No wrapper-specific SimpleEnglish configuration is required.

Subagents that receive the shared Pi skill directory can discover the skill under the same name. Existing role settings that disable automatic skill inheritance remain authoritative. Explicit skill injection remains available for those roles.

## Data flow

1. Nix fetches the pinned upstream Git source and verifies its fixed hash.
2. The Pi configuration build links the upstream skill directory into `${piConfig}/skills/simple-english`.
3. Pi scans the shared skills directory and reads the `simple-english` metadata.
4. Pi includes the skill in discovery results for each launch profile.
5. When a task matches the skill description, Pi makes the skill available through its normal skill-loading workflow.
6. The model reads `SKILL.md` and any referenced files that the task requires.

For unrelated tasks, Pi includes only the normal skill-discovery metadata. Pi does not inject the full `SKILL.md` or the 487-token standalone system prompt into every model call.

## Failure handling

- A missing or changed upstream tag causes fixed-source fetch verification to fail.
- Upstream content drift causes a source-hash mismatch and blocks the build.
- A missing `skills/simple-english/SKILL.md` path causes the Pi configuration build or discovery verification to fail.
- A duplicate `simple-english` entry in the packaged skill directory causes the link step to fail instead of silently replacing another skill.
- Runtime discovery checks detect a package that builds but does not expose the skill to Pi.

## Verification

Extend the existing runtime skill-discovery assertions in `modules/checks/pi-config-extension-load.nix` to require `simple-english` for:

- the Superpowers profile,
- the Matt profile,
- the `pi-matt` convenience launch.

Run these commands before completion:

```sh
nix build .#packages.x86_64-linux.pi-config --no-link
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
```

Inspect the built Pi configuration to confirm that `skills/simple-english/SKILL.md` and both reference files resolve inside the Nix store.

The existing runtime check proves actual Pi skill discovery. A separate test that only restates Nix source values or link text would not add behavioral coverage and is outside the project's Testing Value Gate.

## Update policy

Future updates must change the pinned tag and source hash together. Each update must rerun the package build, runtime discovery check, and full flake check.

## Success criteria

- The source is pinned to SimpleEnglish `v1.2.0` with a valid fixed hash.
- The packaged Pi configuration contains a working `skills/simple-english` link.
- `SKILL.md` and its reference files resolve from the packaged skill directory.
- Pi discovers `simple-english` in both configured skill-set profiles.
- No standalone SimpleEnglish system prompt is added to `AGENTS.md` or wrapper prompts.
- No runtime installer or network fetch is required after the Nix build.
- The required Nix checks pass.
