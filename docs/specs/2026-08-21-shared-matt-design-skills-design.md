# Shared Matt Design Skills Integration

**Date:** 2026-08-21

## Status

Approved in conversation on 2026-08-21.

## Goal

Add two pinned Matt Pocock skills to the shared Pi configuration:

- `codebase-design`
- `domain-modeling`

Both skills must remain available in Matt launches. All other Matt skills must remain limited to the Matt workflow suite.

## Approved behavior

- Reuse the existing pinned `mattpocock/skills` source.
- Install each complete upstream skill directory in the shared Pi skills directory.
- Preserve each skill's reference files and agent metadata.
- Make both skills available in plain `pi`, `pi-matt`, jailed Pi, and project Pi resources.
- Keep the complete `mattpocock-skills` package unchanged.
- Use Pi's canonical-path deduplication when a Matt launch sees each shared skill through two discovery paths.
- Require no runtime download or mutable installation step.

## Non-goals

- Do not copy the upstream files into this repository's `skills/` directory.
- Do not expose other Matt engineering or productivity skills through the shared configuration.
- Do not change the Matt source revision or hash.
- Do not change the workflow-suite selector or routing instructions.
- Do not rename `domain-modeling` to the British spelling.

## Architecture

### Shared skill links

`modules/packages/pi-config.nix` will add two links under `${piConfig}/skills`:

```text
skills/codebase-design
  -> ${piDeps.mattPocockSkills}/skills/engineering/codebase-design

skills/domain-modeling
  -> ${piDeps.mattPocockSkills}/skills/engineering/domain-modeling
```

The links target the existing complete Matt skills package. They do not create another source fetch or another copy in this repository.

The build will confirm that each target contains `SKILL.md` before it creates the links. A changed upstream layout will stop the build.

### Companion files

Each link exposes the complete upstream directory.

`codebase-design` includes its design guides and agent metadata. `domain-modeling` includes its context formats, ADR format, and agent metadata.

Relative references from each `SKILL.md` file will continue to resolve inside the linked directory.

### Matt launch deduplication

The Matt wrapper already loads `${piDeps.mattPocockSkills}` as its workflow-suite package. The shared links resolve to directories inside that same immutable store path.

Pi deduplicates these canonical paths during discovery. A probe confirmed one discovered entry for each skill and no collision warning.

The Matt package will remain complete. A standalone consumer of `mattpocock-skills` will continue to receive both skills.

## Launch behavior

### Plain Pi

Plain `pi` loads the shared Pi skills directory and the Superpowers workflow suite. It will discover the two selected Matt skills through the new links.

It will not discover the other Matt workflow skills.

### Matt Pi

Matt launches load the shared Pi skills directory and the complete Matt workflow suite. The two discovery paths resolve to the same canonical directories.

Pi will expose one entry for each selected skill. All remaining Matt skills will continue to come from the Matt workflow-suite package.

### Other shared-resource launches

Jailed Pi and project Pi resources use the same packaged skills directory. They will receive both selected skills without separate configuration.

## Failure handling

- A missing selected skill or `SKILL.md` file will stop the Nix build.
- A name conflict with a repository-owned shared skill will stop link creation.
- The fixed source hash will stop unapproved upstream content changes.
- Runtime discovery checks will detect a built package that does not expose either skill.
- The Matt runtime check will reject duplicate discovered names.
- The built-link inspection will confirm the canonical path that prevents symlink collision warnings.

## Verification

Extend `modules/checks/pi-config-extension-load.nix` to require both skills in:

- the Superpowers profile
- the Matt selector profile
- the `pi-matt` convenience profile

The existing profile probe reports the skills that Pi discovers at runtime. The check will require one entry for each selected skill.

The built-link inspection will compare each link with the directory that the Matt package loads. Exact path equality confirms the canonical-path deduplication condition.

Inspect the built configuration to confirm that each link resolves to a complete upstream skill directory.

Run these commands before completion:

```sh
nix build .#packages.x86_64-linux.pi-config --no-link
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
```

No new test will assert the source revision, hash, or literal Nix link text. Those tests only restate static configuration.

## Update policy

A future Matt source update will update both shared skills and the Matt workflow suite together. The update must run the package build and runtime checks.

## Success criteria

- The shared Pi configuration contains `codebase-design` and `domain-modeling`.
- Both links expose complete upstream skill directories.
- Plain `pi` discovers both skills without loading other Matt workflow skills.
- Matt launches discover one entry for each selected skill.
- The complete `mattpocock-skills` package remains unchanged.
- Jailed Pi and project Pi resources receive both skills.
- No source copy exists under the repository-owned `skills/` directory.
- The required Nix checks pass.
