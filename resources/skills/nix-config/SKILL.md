---
name: nix-config
description: Use when editing Nix or Home Manager config, especially Pi packages, git sources, npm packages, flakes, jailed agents, or new files referenced by Nix expressions
---

# Nix Config

## Overview

Nix-managed config should resolve resources at build time, not at app runtime. Prefer store paths and derivations over URLs or mutable installs, especially for jailed or immutable environments.

## Pi Package Sources

Do not put raw Git URLs in generated Pi settings when the package must work inside a Nix-managed or jailed setup:

```nix
# Avoid: Pi clones/installs at runtime
"https://github.com/user/package.git"

# Prefer: Nix fetches/builds, Pi reads immutable store path
"${packageDerivation}/lib/node_modules/package-name"
```

For Git packages without runtime dependencies, `pkgs.fetchgit` may be enough. For packages with `package.json` dependencies, use `pkgs.buildNpmPackage` so `node_modules` exists in the store.

## npm Packages from Git

Check `package.json` before using a fetched source directly:

- Has `dependencies`? Use `pkgs.buildNpmPackage`.
- Needs no install/build step? A fetched store path may be fine.
- Has peer deps supplied by Pi? Keep them peer deps, but still package regular deps.

Use the fake-hash cycle for npm dependencies:

```nix
npmDepsHash = pkgs.lib.fakeHash;
```

Build once, copy the reported hash, then rebuild.

## Testing New Nix Files

New files referenced by flake outputs must be staged before normal git-backed flake tests see them.

If a new file is untracked, commands like this can fail because the flake source excludes it:

```sh
nix build .#homeConfigurations."user@host".activationPackage
```

For temporary pre-stage checks, use a path flake:

```sh
nix build --impure --expr '(builtins.getFlake "path:/path/to/repo").homeConfigurations."user@host".activationPackage'
```

Before final verification or committing, stage the new files and rerun the normal flake command.

## Quick Checklist

- [ ] No raw runtime Git URLs for Nix-managed Pi packages
- [ ] `package.json` dependencies are handled with `buildNpmPackage`
- [ ] Store paths point at the actual loadable package/resource directory
- [ ] New referenced files are staged before normal flake verification
- [ ] Verification command matches the affected host or Home Manager profile
