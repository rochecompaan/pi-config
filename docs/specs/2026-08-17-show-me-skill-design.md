# Show Me Skill Integration Design

**Date:** 2026-08-17

## Goal

Add HumanLayer's `show-me` skill to the repository-owned Pi skills directory so every Pi configuration built from this repository can discover it through the existing shared skill path.

## Approved behavior

- Copy the upstream `SKILL.md` unchanged into `skills/show-me/SKILL.md`.
- Use the source file at <https://github.com/humanlayer/skills/blob/main/plugins/show-me/skills/show-me/SKILL.md>.
- Let Pi discover the skill through its native `SKILL.md` discovery.
- Include the skill in the packaged Pi configuration through the existing recursive copy of `./skills`.
- Keep the integration local and immutable after the repository is built.

## Non-goals

- Do not add a Nix fetcher or pin an upstream Git revision.
- Do not modify `nix/packages/pi-deps.nix` or add an external skill symlink.
- Do not rewrite the upstream `open` command for Linux.
- Do not add a wrapper command or supporting files that upstream does not provide.
- Do not append the skill instructions to `AGENTS.md` or another system prompt.
- Do not add a test that only checks static file text or Nix copy statements.

## Architecture

### Repository-owned skill

Add one new file:

```text
skills/
└── show-me/
    └── SKILL.md
```

The file remains an unchanged copy of the upstream skill. The repository owns the copied snapshot from that point onward; future upstream updates require an explicit replacement and review.

### Pi configuration packaging

`modules/packages/pi-config.nix` already runs:

```sh
cp -r ${../../skills} "$out/skills"
```

No Nix source or packaging change is needed. The new directory will appear as `${piConfig}/skills/show-me` in the build output and will propagate through the existing Home Manager, jailed Pi, project-resource, and skill-set launch paths that use the packaged skills directory.

## Data flow

1. The upstream `SKILL.md` is copied unchanged into `skills/show-me/SKILL.md`.
2. Nix copies the repository's complete `skills` directory into the Pi configuration package.
3. Pi scans the shared skills directory and reads the `show-me` metadata.
4. Pi exposes `show-me` through normal skill discovery.
5. When selected, the model reads the vendored `SKILL.md` and follows its visual-explanation guidance.

## Failure handling

- A missing or malformed `SKILL.md` prevents Pi from discovering the skill.
- A packaging regression that omits repository-owned skills is caught by building and inspecting the Pi configuration output.
- Pi startup or extension-loading regressions are caught by the existing runtime extension-load check.
- Upstream changes do not alter the local skill automatically; updates are deliberate repository changes.
- The upstream `open` command may not exist on Linux. This is accepted because the approved scope requires an unchanged copy.

## Verification

Use direct verification rather than adding a new automated test for static skill text:

1. Compare `skills/show-me/SKILL.md` byte-for-byte with the retrieved upstream file.
2. Build `.#packages.x86_64-linux.pi-config`.
3. Confirm the output contains `skills/show-me/SKILL.md`.
4. Run `.#checks.x86_64-linux.pi-config-extension-load` to exercise Pi's packaged startup and skill scan.
5. Run the full flake check.

Commands:

```sh
nix build .#packages.x86_64-linux.pi-config --no-link
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
git diff --check
```

No new automated test is justified by the Testing Value Gate because the requested change is a static, unchanged skill document. Package inspection and the existing runtime check verify the integration without restating the file's contents in test code.

## Success criteria

- `skills/show-me/SKILL.md` matches the requested upstream file.
- The packaged Pi configuration contains `skills/show-me/SKILL.md`.
- Existing Pi runtime extension-load and skill-scan checks pass.
- The full flake check passes.
- No Nix fetcher, source pin, external skill link, system-prompt change, or Linux-specific content patch is added.
