# Remove Jailed Pi and the Jailed GitHub Broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all active jailed Pi and jailed GitHub broker code while keeping historical plans and specifications.

**Architecture:** Remove both coupled runtimes as one Nix surface change. Then remove current guidance and the last active test reference. `import-tree` will stop exporting deleted Nix modules automatically.

**Tech Stack:** Nix flakes, Flake Parts, Home Manager, TypeScript tests, Markdown

## Global Constraints

- Keep all historical files under `docs/plans/` and `docs/specs/`.
- Do not add compatibility stubs for removed interfaces.
- Preserve the normal Pi package, Home Manager module, project shell hook, authentication, and sessions.
- Keep generic Nix skill guidance about immutable or jailed environments.
- Update `flake.lock` without changing unrelated input revisions.
- Do not modify the unrelated main-checkout `package-lock.json`.
- Use direct validation instead of new tests for static configuration and file removal.

## Testing Value Gate

New automated tests would only assert that static files or outputs are absent. Direct scans and Nix evaluation give clearer evidence with no maintenance cost.

The existing `auth-scope` test remains valuable because it validates path classification. Replace its jailed path fixture with a generic local path.

---

### Task 1: Remove the jailed runtime and broker surface

**Files:**
- Delete: `packages/jailed-github-broker/`
- Delete: `modules/checks/jailed-github-broker-real-jail.nix`
- Delete: `modules/checks/jailed-github-broker-wiring.nix`
- Delete: `modules/checks/jailed-github-broker.nix`
- Delete: `modules/checks/jailed-pi-auth-mode.nix`
- Delete: `modules/checks/jailed-pi-git-identity-home.nix`
- Delete: `modules/checks/jailed-pi-git-identity-wiring.nix`
- Delete: `modules/checks/jailed-pi-git-identity.nix`
- Delete: `modules/home/jailed-pi.nix`
- Delete: `modules/lib/jailed-pi.nix`
- Delete: `modules/packages/jailed-github-broker.nix`
- Delete: `nix/check-support/jailed-github-broker-*`
- Delete: `nix/lib/jailed-github-broker.nix`
- Delete: `nix/lib/jailed-github-broker-*`
- Delete: `nix/lib/jailed-pi-auth.nix`
- Delete: `nix/lib/jailed-pi-git-identity.nix`
- Delete: `nix/lib/mk-jailed-pi.nix`
- Delete: `nix/packages/jailed-github-broker.nix`
- Modify: `flake.nix:14-17`
- Modify: `flake.lock`
- Modify: `modules/devshells/default.nix:3-52`
- Modify: `modules/lib/project-pi.nix:9-74`
- Validate: existing Nix flake evaluation

**Interfaces:**
- Consumes: `inputs.import-tree`, `self'.packages.pi-config`, and the existing normal `projectPiShellHook` behavior.
- Produces: a flake with no jailed modules, packages, checks, libraries, or devshells.
- Produces: `projectPiShellHook { extraSettings ? { }, includePackage ? false }` with normal project links only.

- [ ] **Step 1: Delete the jailed implementation, packages, helpers, and checks**

```bash
rm -rf packages/jailed-github-broker
rm -f \
  modules/checks/jailed-github-broker-*.nix \
  modules/checks/jailed-github-broker.nix \
  modules/checks/jailed-pi-*.nix \
  modules/home/jailed-pi.nix \
  modules/lib/jailed-pi.nix \
  modules/packages/jailed-github-broker.nix \
  nix/check-support/jailed-github-broker-* \
  nix/lib/jailed-github-broker.nix \
  nix/lib/jailed-github-broker-* \
  nix/lib/jailed-pi-auth.nix \
  nix/lib/jailed-pi-git-identity.nix \
  nix/lib/mk-jailed-pi.nix \
  nix/packages/jailed-github-broker.nix
```

Expected: all listed paths disappear. Files outside these paths remain unchanged.

- [ ] **Step 2: Remove the jail flake input**

Delete this entry from `flake.nix`:

```nix
    jail-nix.url = "sourcehut:~alexdavid/jail.nix";
```

Keep the other inputs unchanged.

- [ ] **Step 3: Remove the jailed development shell**

Replace `modules/devshells/default.nix` with this content:

```nix
{ ... }:
{
  perSystem =
    {
      config,
      pkgs,
      self',
      ...
    }:
    {
      devShells.default = pkgs.mkShell {
        packages = [
          self'.packages.pi
          self'.packages.pi-matt
          self'.packages.codegraph
          self'.packages.codegraph-viz
          self'.packages.pi-local-auth
          pkgs.git
          pkgs.jq
          pkgs.nixfmt-rfc-style
        ];

        shellHook = config.lib.projectPiShellHook { };
      };

      formatter = pkgs.nixfmt-rfc-style;
    };
}
```

Expected: `devShells.default` and the formatter remain. `devShells.jailed-pi` disappears.

- [ ] **Step 4: Remove jailed setup from the project shell hook**

Replace `modules/lib/project-pi.nix` with this content:

```nix
{ ... }:
{
  perSystem =
    { pkgs, self', ... }:
    let
      piConfigPackage = self'.packages.pi-config;
    in
    {
      lib.projectPiShellHook =
        {
          extraSettings ? { },
          includePackage ? false,
        }:
        let
          settings = pkgs.lib.recursiveUpdate (
            { }
            // pkgs.lib.optionalAttrs includePackage {
              packages = [ "${piConfigPackage}" ];
            }
          ) extraSettings;
        in
        ''
          mkdir -p .pi
          ln -sfnT ${piConfigPackage}/agents .pi/agents
          ln -sfnT ${piConfigPackage}/multi-model-planning-teams .pi/multi-model-planning-teams
          ln -sfnT ${piConfigPackage}/mcp.json .pi/mcp.json
          ln -sfnT ${piConfigPackage}/claude-bridge.json .pi/claude-bridge.json
          cat > .pi/settings.json <<'EOF'
          ${builtins.toJSON settings}
          EOF
        '';
    };
}
```

Expected: existing normal links and settings remain. The `jailedPi` argument and jailed directory setup disappear.

- [ ] **Step 5: Update the lock file**

Run:

```bash
nix flake lock
```

Expected: only the `jail-nix` node and its root reference disappear from `flake.lock`.

- [ ] **Step 6: Format the remaining Nix files**

Run:

```bash
nix fmt -- flake.nix modules/devshells/default.nix modules/lib/project-pi.nix
```

Expected: the formatter exits with status 0.

- [ ] **Step 7: Scan the runtime surface**

Run:

```bash
if git grep -n -i -E \
  'jailed[- ]?pi|jailed-github-broker|agent-jailed|mkJailedPi|jail-nix|programs\.roche-pi\.jailed|projectPiShellHook\.jailedPi' \
  -- ':!docs/plans/**' ':!docs/specs/**' ':!README.md' ':!extensions/auth-scope/index.test.ts'
then
  echo "unexpected jailed runtime reference" >&2
  exit 1
fi
```

Expected: the command exits with status 0 and prints no reference.

- [ ] **Step 8: Evaluate all remaining flake checks**

Run:

```bash
nix flake check --no-build --accept-flake-config --print-build-logs
```

Expected: Nix evaluates the complete flake and exits with status 0.

- [ ] **Step 9: Validate the diff**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace error appears. The status contains only the planned runtime removals and Nix edits.

- [ ] **Step 10: Commit the runtime removal**

```bash
git add -A -- flake.nix flake.lock modules nix packages/jailed-github-broker
git commit -m "chore(jailed-pi): remove runtime and broker"
```

Expected: the commit contains no README, historical document, or unrelated file change.

---

### Task 2: Remove current guidance and the last active fixture

**Files:**
- Modify: `README.md:38-70`
- Modify: `README.md:118-154`
- Modify: `extensions/auth-scope/index.test.ts:31-35`
- Validate: `extensions/auth-scope/index.test.ts`
- Validate: `checks.x86_64-linux.pi-config-extension-load`
- Validate: full flake check

**Interfaces:**
- Consumes: the reduced flake from Task 1.
- Produces: current documentation with no jailed usage instructions.
- Produces: the same `classifyAuthScope` test coverage with a generic local path fixture.

- [ ] **Step 1: Replace the jailed authentication fixture**

In `extensions/auth-scope/index.test.ts`, replace:

```ts
		"~/.pi/agent-jailed",
```

with:

```ts
		"~/.pi/local-agent",
```

Expected: the test still covers a home-relative non-global agent directory.

- [ ] **Step 2: Run the authentication scope tests**

Run:

```bash
node --experimental-strip-types --test extensions/auth-scope/index.test.ts
```

Expected: 5 tests pass and 0 tests fail. Node can print the existing module-type warning.

- [ ] **Step 3: Remove current jailed usage guidance**

Remove these parts from `README.md`:

- The sentence that says jailed Pi is fixed to Superpowers.
- The complete `### Jailed Pi` section.
- The complete `### Project jailed Pi shell` section.

Replace the per-project sentence with this text:

```markdown
Add `.pi/` to the project `.gitignore`, then run `devenv shell` and launch `pi`. This uses the Pi executable. `PI_CODING_AGENT_DIR` points to the repository-local `.pi/agent`, which receives the packaged configuration while keeping project credentials and sessions out of the global agent directory.
```

Expected: the README documents only the normal Home Manager and project shell paths.

- [ ] **Step 4: Scan all active tracked files**

Run:

```bash
if git grep -n -i -E \
  'jailed[- ]?pi|jailed-github-broker|agent-jailed|mkJailedPi|jail-nix|programs\.roche-pi\.jailed|projectPiShellHook\.jailedPi' \
  -- ':!docs/plans/**' ':!docs/specs/**'
then
  echo "unexpected active jailed reference" >&2
  exit 1
fi
```

Expected: the command exits with status 0 and prints no reference. Historical plans and specifications remain unchanged.

- [ ] **Step 5: Build the Pi extension-load check**

Run:

```bash
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Expected: the extension-load check builds and exits with status 0.

- [ ] **Step 6: Run the full flake check**

Run:

```bash
nix flake check --accept-flake-config --print-build-logs
```

Expected: all remaining checks build and exit with status 0.

- [ ] **Step 7: Validate the final diff**

Run:

```bash
git diff --check
git status --short
git diff --stat HEAD
```

Expected: the diff contains only `README.md` and `extensions/auth-scope/index.test.ts` after the Task 1 commit.

- [ ] **Step 8: Commit the active reference cleanup**

```bash
git add README.md extensions/auth-scope/index.test.ts
git commit -m "docs(pi): remove jailed usage guidance"
```

Expected: the worktree is clean after the commit.

## Final review evidence

The implementation review must include:

- The approved specification at `docs/specs/2026-09-14-remove-jailed-pi-design.md`.
- This plan at `docs/plans/2026-09-14-remove-jailed-pi.md`.
- The base commit before Task 1 and the final head commit.
- The active-reference scan result.
- The extension-load build result.
- The full flake check result.
