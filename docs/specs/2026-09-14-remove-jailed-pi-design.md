# Remove Jailed Pi and the Jailed GitHub Broker

**Date:** 2026-09-14
**Status:** Approved

## Context

This repository provides a jailed Pi runtime and a repository-scoped GitHub broker. Both features add Nix modules, packages, tests, source code, and documentation.

The repository no longer needs either feature. Their historical plans and design specifications remain useful as project records.

## Goals

- Remove the active jailed Pi runtime and its public interfaces.
- Remove the jailed GitHub broker implementation and its public interfaces.
- Remove tests and support files that exist only for these features.
- Remove current usage guidance from `README.md`.
- Remove the unused `jail-nix` flake input and its lock data.
- Keep historical files under `docs/plans/` and `docs/specs/`.
- Preserve unrelated Pi, Home Manager, devshell, and authentication behavior.

## Non-goals

- Do not rewrite historical plans or design specifications.
- Do not remove generic guidance about immutable or jailed environments from the Nix skill.
- Do not change the normal Pi package or its Home Manager module.
- Do not change `pi-local-auth` beyond removal of jailed-only references.
- Do not change unrelated files in the main checkout.

## Removal design

Delete the complete Go source tree at `packages/jailed-github-broker/`. Delete its Nix package module and package expression.

Delete the jailed broker libraries, lifecycle scripts, audit helper, anchor source, test support, and checks. No broker compatibility package remains.

Delete the jailed Pi Home Manager module, library module, builder, authentication helper, Git identity helper, checks, and dedicated devshell. Remove their module exports.

Simplify `projectPiShellHook` to support only the normal project Pi configuration. Remove its `jailedPi` argument and all jailed directory setup.

Remove `jail-nix` from `flake.nix`. Update `flake.lock` through Nix so unrelated input versions do not change.

Remove the jailed Pi sections from `README.md`. Remove active test cases that name the deleted jailed agent directory.

Keep all existing historical plans and specifications. Historical references can describe files and behavior that no longer exist.

## Public interface changes

The following interfaces disappear:

- `homeModules."jailed-pi"`
- `lib.${system}.mkJailedPi`
- `packages.${system}.jailed-github-broker`
- `devShells.${system}.jailed-pi`
- `projectPiShellHook.jailedPi`
- `programs.roche-pi.jailed`

Consumers must use the normal Pi package, Home Manager module, or project shell hook.

## Error handling

This removal adds no runtime path and no new error handling. Nix evaluation must fail clearly for consumers that still use a removed interface.

The repository must not keep compatibility stubs. A missing interface gives consumers an immediate migration signal.

## Validation

This change removes static configuration and source trees. New automated tests would only restate file absence, so the Testing Value Gate excludes them.

Use these validation steps:

1. Search tracked non-historical files for jailed Pi and broker references.
2. Evaluate the flake outputs and make sure that removed outputs are absent.
3. Build the Pi extension-load check:

   ```sh
   nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
   ```

4. Run the full flake check:

   ```sh
   nix flake check --accept-flake-config --print-build-logs
   ```

5. Make sure that the diff contains no unrelated changes.

## Migration

Downstream repositories must remove imports and calls for the deleted interfaces. They can replace jailed Pi with the normal project Pi shell when required.
