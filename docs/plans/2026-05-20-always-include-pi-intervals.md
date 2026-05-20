# Always Include pi-intervals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bundle `pi-intervals` into Roche Pi by default so normal Pi and jailed Pi always have the extension and skill available without local path configuration.

**Architecture:** Add a first-class Nix package that builds `pi-intervals` from the GitHub remote with `buildNpmPackage`. Link that package into the base `pi-config` package's `extensions` and `skills` directories so every existing consumer of `pi-config`, including `mkJailedPi`, automatically receives the extension in its runtime closure. Remove the old optional intervals plumbing from Home Manager/resource helpers and remove the now-invalid Clubhouse devshell override.

**Tech Stack:** Nix flakes, flake-parts/import-tree modules, `pkgs.buildNpmPackage`, Home Manager modules, `jail-nix` wrapped Pi.

---

## File structure

- Create `nix/packages/pi-intervals.nix`: fetch and build `sixfeetup/pi-intervals` from GitHub at a pinned revision.
- Create `modules/packages/pi-intervals.nix`: expose the package as `packages.pi-intervals` in the Roche Pi flake.
- Modify `modules/packages/pi-config.nix`: link the built `pi-intervals` package into `pi-config/extensions/pi-intervals` and its skill into `pi-config/skills/intervals-time-entries`.
- Modify `nix/lib/pi-resources.nix`: remove the optional `intervals` argument and related conditional resource composition because the base package always includes the extension.
- Modify `modules/home/pi.nix`: remove `programs.roche-pi.intervals.*` options/assertions and stop passing intervals into `pi-resources.nix`.
- Modify `modules/home/jailed-pi.nix`: stop passing intervals into `pi-resources.nix`; jailed Pi inherits `pi-intervals` from `pi-config`.
- Modify `/home/roche/projects/clubhouse/clubhouse_server/devenv.nix`: remove the unsupported `intervals = { ... }` argument from `projectPiShellHook`.

## Known pinned values

Use these pinned values for `pi-intervals`:

- GitHub owner: `sixfeetup`
- GitHub repo: `pi-intervals`
- Rev: `c94d30faa746158ae8c44c103f893e0a04f88d38`
- Source hash: `sha256-sudXd3blxXN1tNZ84hIwWP+ExLkUt1Tbr01obFECGF0=`
- npm deps hash: `sha256-DJWK6Vw7H8GJJQSkoFNAbI5Mkecq5S3LpQtOdqZVSO0=`

---

### Task 1: Add the pi-intervals Nix package

**Files:**
- Create: `nix/packages/pi-intervals.nix`
- Create: `modules/packages/pi-intervals.nix`

- [ ] **Step 1: Create the package derivation**

Create `nix/packages/pi-intervals.nix` with this exact content:

```nix
{ pkgs }:

pkgs.buildNpmPackage {
  pname = "pi-intervals";
  version = "0.1.0-c94d30f";

  src = pkgs.fetchFromGitHub {
    owner = "sixfeetup";
    repo = "pi-intervals";
    rev = "c94d30faa746158ae8c44c103f893e0a04f88d38";
    hash = "sha256-sudXd3blxXN1tNZ84hIwWP+ExLkUt1Tbr01obFECGF0=";
  };

  npmDepsHash = "sha256-DJWK6Vw7H8GJJQSkoFNAbI5Mkecq5S3LpQtOdqZVSO0=";

  dontNpmBuild = true;

  installPhase = ''
    runHook preInstall

    mkdir -p "$out"
    cp -r package.json package-lock.json src skills node_modules "$out/"

    runHook postInstall
  '';

  meta = {
    description = "Pi extension and skill for Intervals time tracking";
    homepage = "https://github.com/sixfeetup/pi-intervals";
    license = pkgs.lib.licenses.mit;
  };
}
```

- [ ] **Step 2: Expose the package from flake-parts**

Create `modules/packages/pi-intervals.nix` with this exact content:

```nix
{ ... }:
{
  perSystem =
    { pkgs, ... }:
    {
      packages."pi-intervals" = import ../../nix/packages/pi-intervals.nix { inherit pkgs; };
    };
}
```

- [ ] **Step 3: Format the new files**

Run:

```bash
cd /home/roche/projects/pi/roche-pi
nixfmt nix/packages/pi-intervals.nix modules/packages/pi-intervals.nix
```

Expected: command exits successfully and keeps the files formatted.

- [ ] **Step 4: Build the new package**

Run:

```bash
cd /home/roche/projects/pi/roche-pi
nix build .#packages.x86_64-linux.pi-intervals
```

Expected: build succeeds and `result` points to a store path containing `package.json`, `src`, `skills`, and `node_modules`.

- [ ] **Step 5: Inspect the package output**

Run:

```bash
cd /home/roche/projects/pi/roche-pi
test -f result/package.json
test -f result/src/index.ts
test -f result/skills/intervals-time-entries/SKILL.md
test -d result/node_modules
```

Expected: all four `test` commands exit successfully.

- [ ] **Step 6: Commit the package**

Run:

```bash
cd /home/roche/projects/pi/roche-pi
git add nix/packages/pi-intervals.nix modules/packages/pi-intervals.nix
git commit -m "feat(pi): package pi-intervals"
```

Expected: commit succeeds.

---

### Task 2: Bundle pi-intervals into pi-config

**Files:**
- Modify: `modules/packages/pi-config.nix`

- [ ] **Step 1: Update `pi-config.nix` to reference the package**

In `modules/packages/pi-config.nix`, inside the `let` block after this line:

```nix
      piPackage = inputs.llm-agents.packages.${system}.pi;
```

add this line:

```nix
      piIntervals = self'.packages."pi-intervals";
```

- [ ] **Step 2: Link extension and skill into `pi-config`**

In `modules/packages/pi-config.nix`, inside the `piConfig = pkgs.runCommand "pi-config" { } ''` script, after this existing line:

```sh
        cp -r ${../../agent-teams} "$out/agent-teams"
```

add these lines:

```sh

        ln -s ${piIntervals} "$out/extensions/pi-intervals"
        ln -s ${piIntervals}/skills/intervals-time-entries "$out/skills/intervals-time-entries"
```

- [ ] **Step 3: Format the modified file**

Run:

```bash
cd /home/roche/projects/pi/roche-pi
nixfmt modules/packages/pi-config.nix
```

Expected: command exits successfully.

- [ ] **Step 4: Build `pi-config`**

Run:

```bash
cd /home/roche/projects/pi/roche-pi
nix build .#packages.x86_64-linux.pi-config
```

Expected: build succeeds and `result` points to the generated `pi-config` package.

- [ ] **Step 5: Verify bundled links**

Run:

```bash
cd /home/roche/projects/pi/roche-pi
test -f result/extensions/pi-intervals/package.json
test -f result/extensions/pi-intervals/src/index.ts
test -f result/skills/intervals-time-entries/SKILL.md
nix-store -q --references result | grep pi-intervals
```

Expected: all tests pass, and `grep` prints a store path containing `pi-intervals-0.1.0-c94d30f`.

- [ ] **Step 6: Commit the bundle change**

Run:

```bash
cd /home/roche/projects/pi/roche-pi
git add modules/packages/pi-config.nix
git commit -m "feat(pi): bundle pi-intervals in config"
```

Expected: commit succeeds.

---

### Task 3: Remove optional intervals resource plumbing

**Files:**
- Modify: `nix/lib/pi-resources.nix`
- Modify: `modules/home/pi.nix`
- Modify: `modules/home/jailed-pi.nix`

- [ ] **Step 1: Simplify `pi-resources.nix` arguments**

In `nix/lib/pi-resources.nix`, replace the function header:

```nix
{
  pkgs,
  package,
  settings ? { },
  stylix ? {
    enable = false;
    colors = null;
  },
  intervals ? {
    enable = false;
    path = null;
    package = null;
  },
}:
```

with:

```nix
{
  pkgs,
  package,
  settings ? { },
  stylix ? {
    enable = false;
    colors = null;
  },
}:
```

- [ ] **Step 2: Remove interval target definitions**

In `nix/lib/pi-resources.nix`, delete this entire block:

```nix
  intervalsExtensionsTarget =
    if intervals.package != null then
      "${intervals.package}/extensions/pi-intervals"
    else
      intervals.path;

  intervalsSkillsTarget =
    if intervals.package != null then
      "${intervals.package}/skills/intervals-time-entries"
    else
      "${intervals.path}/skills/intervals-time-entries";
```

- [ ] **Step 3: Replace conditional `extensions` with the package extensions path**

In `nix/lib/pi-resources.nix`, replace this entire block:

```nix
  extensions =
    if intervals.enable then
      pkgs.runCommand "roche-pi-extensions"
        {
          baseExtensions = "${package}/extensions";
          inherit intervalsExtensionsTarget;
        }
        ''
          mkdir -p "$out"
          cp -rT "$baseExtensions" "$out"
          ln -s "$intervalsExtensionsTarget" "$out/pi-intervals"
        ''
    else
      "${package}/extensions";
```

with:

```nix
  extensions = "${package}/extensions";
```

- [ ] **Step 4: Replace conditional `skills` with the package skills path**

In `nix/lib/pi-resources.nix`, replace this entire block:

```nix
  skills =
    if intervals.enable then
      pkgs.runCommand "roche-pi-skills"
        {
          baseSkills = "${package}/skills";
          inherit intervalsSkillsTarget;
        }
        ''
          mkdir -p "$out"
          cp -rT "$baseSkills" "$out"
          ln -s "$intervalsSkillsTarget" "$out/intervals-time-entries"
        ''
    else
      "${package}/skills";
```

with:

```nix
  skills = "${package}/skills";
```

- [ ] **Step 5: Remove normal Home Manager interval imports and options**

In `modules/home/pi.nix`, remove `hasPrefix` from the inherited lib names. Change:

```nix
  inherit (lib)
    hasPrefix
    mkEnableOption
```

to:

```nix
  inherit (lib)
    mkEnableOption
```

In the `piResources = import ...` call, delete this argument block:

```nix
        intervals = {
          inherit (cfg.intervals) enable path package;
        };
```

In `options.programs."roche-pi"`, delete this entire option block:

```nix
        intervals = {
          enable = mkOption {
            type = types.bool;
            default = false;
          };

          path = mkOption {
            type = types.nullOr types.str;
            default = null;
            description = "Absolute path to the local pi-intervals extension checkout (extension root).";
          };

          package = mkOption {
            type = types.nullOr types.package;
            default = null;
          };
        };
```

Inside `config = mkIf cfg.enable {`, delete the `assertions = [...]` block that only validates `cfg.intervals`:

```nix
        assertions = [
          {
            assertion = !cfg.intervals.enable || cfg.intervals.path != null || cfg.intervals.package != null;
            message = "programs.roche-pi.intervals.enable requires either programs.roche-pi.intervals.path or programs.roche-pi.intervals.package.";
          }
          {
            assertion = cfg.intervals.path == null || hasPrefix "/" cfg.intervals.path;
            message = "programs.roche-pi.intervals.path must be null or an absolute path.";
          }
        ];
```

- [ ] **Step 6: Remove jailed Home Manager interval argument**

In `modules/home/jailed-pi.nix`, inside the `piResources = import ...` call, delete this argument block:

```nix
        intervals = {
          inherit (piCfg.intervals) enable path package;
        };
```

- [ ] **Step 7: Format modified files**

Run:

```bash
cd /home/roche/projects/pi/roche-pi
nixfmt nix/lib/pi-resources.nix modules/home/pi.nix modules/home/jailed-pi.nix
```

Expected: command exits successfully.

- [ ] **Step 8: Build normal and jailed config packages**

Run:

```bash
cd /home/roche/projects/pi/roche-pi
nix build .#packages.x86_64-linux.pi-config
nix build .#devShells.x86_64-linux.jailed-pi
```

Expected: both builds succeed.

- [ ] **Step 9: Verify no intervals option references remain**

Run:

```bash
cd /home/roche/projects/pi/roche-pi
rg "cfg\.intervals|piCfg\.intervals|programs\.roche-pi\.intervals|intervals \?" modules nix
```

Expected: `rg` exits with no matches.

- [ ] **Step 10: Commit the plumbing removal**

Run:

```bash
cd /home/roche/projects/pi/roche-pi
git add nix/lib/pi-resources.nix modules/home/pi.nix modules/home/jailed-pi.nix
git commit -m "refactor(pi): remove optional intervals config"
```

Expected: commit succeeds.

---

### Task 4: Verify project jailed Pi resources

**Files:**
- No source changes in Roche Pi unless verification reveals a regression.

- [ ] **Step 1: Enter the Roche Pi jailed devshell once**

Run:

```bash
cd /home/roche/projects/pi/roche-pi
nix develop .#jailed-pi --command bash -lc 'readlink -f .pi/agent-jailed/extensions/pi-intervals && readlink -f .pi/agent-jailed/skills/intervals-time-entries'
```

Expected: both commands print `/nix/store/...` paths. The first path contains `pi-intervals-0.1.0-c94d30f`; the second path ends with `skills/intervals-time-entries`.

- [ ] **Step 2: Smoke-test jailed Pi startup**

Run:

```bash
cd /home/roche/projects/pi/roche-pi
nix develop .#jailed-pi --command jailed-pi --help
```

Expected: Pi prints help or usage text and exits successfully. It must not fail because `pi-intervals` or `intervals-time-entries` is missing.

- [ ] **Step 3: Commit only if a fix was needed**

If Steps 1 or 2 required source changes, commit those changes with:

```bash
cd /home/roche/projects/pi/roche-pi
git add modules/lib/project-pi.nix modules/devshells/default.nix modules/packages/pi-config.nix nix/lib/pi-resources.nix
git commit -m "fix(pi): expose intervals in jailed shell"
```

Expected: no commit is needed if Steps 1 and 2 passed without source changes. If a source change was needed, the commit succeeds with only the relevant changed files from the explicit `git add` list staged.

---

### Task 5: Remove the obsolete Clubhouse devshell override

**Files:**
- Modify: `/home/roche/projects/clubhouse/clubhouse_server/devenv.nix`

- [ ] **Step 1: Remove unsupported intervals argument**

In `/home/roche/projects/clubhouse/clubhouse_server/devenv.nix`, replace this block inside `enterShell`:

```nix
    ${inputs.roche-pi.lib.${pkgs.system}.projectPiShellHook {
      agentTeam = "openai-only";
      jailedPi.enable = true;
      intervals = {
        enable = true;
        path = "${config.home.homeDirectory}/projects/pi/extensions/pi-intervals";
      };
    }}
```

with:

```nix
    ${inputs.roche-pi.lib.${pkgs.system}.projectPiShellHook {
      agentTeam = "openai-only";
      jailedPi.enable = true;
    }}
```

- [ ] **Step 2: Format the Clubhouse devenv file**

Run:

```bash
nixfmt /home/roche/projects/clubhouse/clubhouse_server/devenv.nix
```

Expected: command exits successfully.

- [ ] **Step 3: Verify no local pi-intervals path remains**

Run:

```bash
rg "pi-intervals|intervals =" /home/roche/projects/clubhouse/clubhouse_server/devenv.nix
```

Expected: `rg` exits with no matches.

- [ ] **Step 4: Build or enter the Clubhouse devshell with the updated Roche Pi input**

If the Clubhouse lock still points at the GitHub `roche-pi` input before this work is pushed, temporarily override it with the local checkout:

```bash
cd /home/roche/projects/clubhouse/clubhouse_server
devenv shell --override-input roche-pi path:/home/roche/projects/pi/roche-pi -- bash -lc 'readlink -f .pi/agent-jailed/extensions/pi-intervals && readlink -f .pi/agent-jailed/skills/intervals-time-entries && command -v jailed-pi'
```

Expected: both `readlink` commands print `/nix/store/...` paths and `command -v jailed-pi` prints a path to the jailed Pi wrapper.

If `devenv shell --override-input` is not supported by the installed devenv version, run this fallback:

```bash
cd /home/roche/projects/clubhouse/clubhouse_server
nix develop --override-input roche-pi path:/home/roche/projects/pi/roche-pi --command bash -lc 'readlink -f .pi/agent-jailed/extensions/pi-intervals && readlink -f .pi/agent-jailed/skills/intervals-time-entries && command -v jailed-pi'
```

Expected fallback result: both `readlink` commands print `/nix/store/...` paths and `command -v jailed-pi` prints a path to the jailed Pi wrapper.

- [ ] **Step 5: Commit the Clubhouse devshell cleanup in the Clubhouse repo**

Run:

```bash
cd /home/roche/projects/clubhouse/clubhouse_server
git status --short
git add devenv.nix
git commit -m "fix(devshell): use bundled pi-intervals"
```

Expected: only `devenv.nix` is staged for this commit, and the commit succeeds.

---

### Task 6: Final verification in Roche Pi

**Files:**
- No source changes unless verification reveals a regression.

- [ ] **Step 1: Run full targeted Roche Pi verification**

Run:

```bash
cd /home/roche/projects/pi/roche-pi
nix flake check
```

Expected: all flake checks pass.

- [ ] **Step 2: Verify the public package outputs exist**

Run:

```bash
cd /home/roche/projects/pi/roche-pi
nix eval .#packages.x86_64-linux.pi-intervals.pname
nix eval .#packages.x86_64-linux.pi-config.name
```

Expected: the first command prints `"pi-intervals"`; the second prints a derivation name containing `pi-config`.

- [ ] **Step 3: Review final Roche Pi git status**

Run:

```bash
cd /home/roche/projects/pi/roche-pi
git status --short
git log --oneline -5
```

Expected: no uncommitted Roche Pi source changes remain except possibly the implementation plan file if it was intentionally left uncommitted. Recent commits include the package, bundle, and optional-config removal commits.

- [ ] **Step 4: Review final Clubhouse git status**

Run:

```bash
cd /home/roche/projects/clubhouse/clubhouse_server
git status --short
git log --oneline -3
```

Expected: no uncommitted Clubhouse devshell changes remain. Recent commits include `fix(devshell): use bundled pi-intervals` if Task 5 was completed.
