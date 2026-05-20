# Always include pi-intervals in Roche Pi

## Context

`roche-pi` currently has optional Home Manager configuration for `pi-intervals`, and project devshells can try to pass an `intervals` block to `projectPiShellHook`. This is brittle for jailed Pi because the jailed agent directory links the base `pi-config` resources unless an intervals-enabled resource package is explicitly constructed. The Clubhouse devshell exposed this gap: `jailed-pi` was available, but `pi-intervals` was missing.

`pi-intervals` should now be a standard part of the Roche Pi agent configuration for both non-jailed and jailed Pi. It should not depend on a local checkout path such as `/home/roche/projects/pi/extensions/pi-intervals`.

## Decision

Build `pi-intervals` from its GitHub remote and always compose it into Roche Pi resources.

The source remote is `git@github.com:sixfeetup/pi-intervals.git`, equivalent to `https://github.com/sixfeetup/pi-intervals.git` for Nix fetches. Because `pi-intervals` has npm dependencies, package it with `pkgs.buildNpmPackage` rather than linking a raw fetched source.

## Design

### Package source

Add a Nix package for `pi-intervals` under the Roche Pi flake. The package will fetch the GitHub remote at a pinned revision and hash, run npm dependency installation using a pinned `npmDepsHash`, and expose the extension root in the store.

The packaged output must include at least:

- `package.json`
- `src/**`
- `skills/intervals-time-entries/**`
- any runtime files needed by Pi to load the TypeScript extension
- installed npm dependencies produced by `buildNpmPackage`

### Resource composition

Change `nix/lib/pi-resources.nix` so `pi-intervals` is always added to the generated resources package:

- link `${piIntervals}/extensions/pi-intervals` into the agent `extensions` directory, or link the packaged extension root directly as `extensions/pi-intervals` if the package output is the extension root;
- link `${piIntervals}/skills/intervals-time-entries` into the agent `skills` directory.

The resources helper should accept a `piIntervalsPackage` argument, defaulting to the flake package where possible at call sites. It should not expose an enable/disable option.

### Home Manager modules

Remove `programs.roche-pi.intervals.*` options and related assertions from the normal Pi Home Manager module. The normal module will always use resources that include `pi-intervals`.

Update the jailed Home Manager module to pass the same `piIntervalsPackage` into resource construction. The jailed activation links already point at `piResources.package`, so once resources include `pi-intervals`, the jailed agent directory will include it automatically.

### Project devshells

Update `projectPiShellHook` to construct and link the same resource package rather than directly linking the base `pi-config` resource directories. When `jailedPi.enable = true`, the project-local jailed agent directory should include `pi-intervals` by default.

The Clubhouse devshell can then remove its unsupported `intervals = { ... }` argument. Its `mkJailedPi.agentConfigPackage` should use the always-intervals-enabled resources package if needed for the jailed runtime closure.

## Testing

Verify the change with:

1. `nix build .#packages.x86_64-linux.pi-intervals`
2. `nix build .#packages.x86_64-linux.pi-config`
3. Enter or build the jailed Pi devshell and confirm `.pi/agent-jailed/extensions/pi-intervals` and `.pi/agent-jailed/skills/intervals-time-entries` resolve to store paths.
4. Run `jailed-pi --help` or an equivalent smoke command from a devshell to ensure Pi starts with the resource closure available.

## Scope boundaries

This change does not alter Intervals API behavior, local time-entry storage, timer behavior, or command/tool names. It only changes how the extension and skill are packaged and included in Roche Pi agent resources.
