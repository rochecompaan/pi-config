# Jailed Pi Authentication Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit global and agent-directory-local authentication modes to jailed Pi while keeping sessions globally shared.

**Architecture:** A focused Nix helper renders the safe auth setup shell shared by Home Manager activation and `projectPiShellHook`. `mkJailedPi` separately enforces the jail credential boundary by including the global auth mount only in global mode. A flake check exercises filesystem migrations and inspects generated wrapper artifacts, while Home Manager evaluation proves option defaults and propagation.

**Tech Stack:** Nix flakes, flake-parts/import-tree modules, Home Manager modules, jail-nix, Bash-backed `pkgs.runCommand` checks.

## Global Constraints

- `authMode` accepts exactly `"global"` and `"local"`.
- Every public interface defaults to `"global"` for backward compatibility.
- The option controls authentication only; `~/.pi/agent/sessions` remains shared in both modes.
- Global mode must not overwrite a regular auth file or unrelated symlink.
- Local mode removes only the known symlink to `~/.pi/agent/auth.json` and preserves all other auth paths.
- Local-mode jailed wrappers must not mount `~/.pi/agent/auth.json`.
- Authentication contents must never enter Nix evaluation or the Nix store.
- Follow the approved design in `docs/specs/2026-07-24-jailed-pi-auth-mode-design.md`.

## File Map

- Create `nix/lib/jailed-pi-auth.nix`: render the shared safe global/local auth setup shell.
- Create `modules/checks/jailed-pi-auth-mode.nix`: behaviorally test filesystem migration, builder mount policy, option validation, and Home Manager propagation.
- Modify `modules/lib/project-pi.nix`: expose `jailedPi.authMode` and use the shared setup helper.
- Modify `modules/lib/jailed-pi.nix`: expose `mkJailedPi.authMode` and conditionally mount global auth.
- Modify `modules/home/jailed-pi.nix`: expose the typed Home Manager option, use the shared setup helper, and pass the mode to the builder.
- Modify `README.md`: document global/local auth selection for Home Manager and project shells.

The existing Home Manager and jailed builder modules are roughly 245 and 229 lines. Keep their new logic declarative and extract the filesystem behavior into `nix/lib/jailed-pi-auth.nix`; do not grow either module with duplicated shell branches.

---

### Task 1: Safe Auth Setup and Project Shell Interface

**Files:**
- Create: `modules/checks/jailed-pi-auth-mode.nix`
- Create: `nix/lib/jailed-pi-auth.nix`
- Modify: `modules/lib/project-pi.nix:9-62`

**Interfaces:**
- Produces: `mkAuthSetup { authMode, globalAuthPathExpr ? ''"$HOME/.pi/agent/auth.json"'' } -> string`.
- Produces: `projectPiShellHook { jailedPi.authMode = "global" | "local"; ... } -> shell string`.
- Preserves: `jailedPi.agentDir` and globally shared session setup.

- [ ] **Step 1: Add the failing project-hook behavior check**

Create `modules/checks/jailed-pi-auth-mode.nix` with project-hook cases that prove safe global and local filesystem behavior:

```nix
{ ... }:
{
  perSystem =
    { pkgs, self', ... }:
    let
      globalHook = pkgs.writeShellScript "jailed-pi-global-auth-hook" (
        self'.lib.projectPiShellHook {
          jailedPi = {
            enable = true;
            authMode = "global";
          };
        }
      );

      localHook = pkgs.writeShellScript "jailed-pi-local-auth-hook" (
        self'.lib.projectPiShellHook {
          jailedPi = {
            enable = true;
            authMode = "local";
          };
        }
      );

      invalidProjectHook = builtins.tryEval (
        self'.lib.projectPiShellHook {
          jailedPi = {
            enable = true;
            authMode = "invalid";
          };
        }
      );
    in
    {
      checks."jailed-pi-auth-mode" =
        assert !invalidProjectHook.success;
        pkgs.runCommand "jailed-pi-auth-mode-check" { } ''
        set -eu

        run_hook() {
          hook="$1"
          test_home="$2"
          test_repo="$3"

          mkdir -p "$test_home" "$test_repo"
          (
            export HOME="$test_home"
            cd "$test_repo"
            "$hook"
          )
        }

        assert_link_target() {
          path="$1"
          expected="$2"
          test -L "$path"
          actual="$(readlink "$path")"
          if [ "$actual" != "$expected" ]; then
            echo "expected $path -> $expected, got $actual" >&2
            exit 1
          fi
        }

        global_home="$TMPDIR/global-home"
        global_repo="$TMPDIR/global-repo"
        run_hook ${globalHook} "$global_home" "$global_repo"
        global_agent="$global_repo/.pi/agent-jailed"
        global_auth="$global_home/.pi/agent/auth.json"
        assert_link_target "$global_agent/auth.json" "$global_auth"
        assert_link_target "$global_agent/sessions" "$global_home/.pi/agent/sessions"

        printf '%s\n' 'global-secret' > "$global_auth"
        run_hook ${globalHook} "$global_home" "$global_repo"
        grep -Fx 'global-secret' "$global_auth"

        regular_home="$TMPDIR/regular-home"
        regular_repo="$TMPDIR/regular-repo"
        mkdir -p "$regular_repo/.pi/agent-jailed"
        printf '%s\n' 'local-secret' > "$regular_repo/.pi/agent-jailed/auth.json"
        if run_hook ${globalHook} "$regular_home" "$regular_repo"; then
          echo "expected global mode to reject an existing local auth file" >&2
          exit 1
        fi
        grep -Fx 'local-secret' "$regular_repo/.pi/agent-jailed/auth.json"

        global_link_home="$TMPDIR/global-link-home"
        global_link_repo="$TMPDIR/global-link-repo"
        mkdir -p "$global_link_repo/.pi/agent-jailed"
        printf '%s\n' 'other-secret' > "$TMPDIR/other-auth.json"
        ln -s "$TMPDIR/other-auth.json" "$global_link_repo/.pi/agent-jailed/auth.json"
        if run_hook ${globalHook} "$global_link_home" "$global_link_repo"; then
          echo "expected global mode to reject an unrelated auth symlink" >&2
          exit 1
        fi
        assert_link_target "$global_link_repo/.pi/agent-jailed/auth.json" "$TMPDIR/other-auth.json"

        local_home="$TMPDIR/local-home"
        local_repo="$TMPDIR/local-repo"
        mkdir -p "$local_repo/.pi/agent-jailed"
        printf '%s\n' 'repo-secret' > "$local_repo/.pi/agent-jailed/auth.json"
        run_hook ${localHook} "$local_home" "$local_repo"
        grep -Fx 'repo-secret' "$local_repo/.pi/agent-jailed/auth.json"
        test ! -e "$local_home/.pi/agent/auth.json"
        assert_link_target "$local_repo/.pi/agent-jailed/sessions" "$local_home/.pi/agent/sessions"

        migrate_home="$TMPDIR/migrate-home"
        migrate_repo="$TMPDIR/migrate-repo"
        run_hook ${globalHook} "$migrate_home" "$migrate_repo"
        printf '%s\n' 'preserved-global-secret' > "$migrate_home/.pi/agent/auth.json"
        run_hook ${localHook} "$migrate_home" "$migrate_repo"
        test ! -e "$migrate_repo/.pi/agent-jailed/auth.json"
        test ! -L "$migrate_repo/.pi/agent-jailed/auth.json"
        grep -Fx 'preserved-global-secret' "$migrate_home/.pi/agent/auth.json"

        unrelated_home="$TMPDIR/unrelated-home"
        unrelated_repo="$TMPDIR/unrelated-repo"
        mkdir -p "$unrelated_repo/.pi/agent-jailed"
        ln -s "$TMPDIR/other-auth.json" "$unrelated_repo/.pi/agent-jailed/auth.json"
        run_hook ${localHook} "$unrelated_home" "$unrelated_repo"
        assert_link_target "$unrelated_repo/.pi/agent-jailed/auth.json" "$TMPDIR/other-auth.json"
        test ! -e "$unrelated_home/.pi/agent/auth.json"

        touch "$out"
      '';
    };
}
```

- [ ] **Step 2: Run the focused check and verify the current forced-link behavior fails**

Because the new check file is untracked, use a path flake so Nix includes it:

```bash
nix build --impure --no-link --expr \
  "(builtins.getFlake \"path:$PWD\").checks.x86_64-linux.jailed-pi-auth-mode"
```

Expected: FAIL at the `!invalidProjectHook.success` assertion because the current hook accepts an unknown mode.

- [ ] **Step 3: Expose the existing destructive-link failure too**

Temporarily comment out only the `assert !invalidProjectHook.success;` line and rerun:

```bash
nix build --impure --no-link --expr \
  "(builtins.getFlake \"path:$PWD\").checks.x86_64-linux.jailed-pi-auth-mode"
```

Expected: FAIL at `expected global mode to reject an existing local auth file` because the current hook replaces that file. Restore the invalid-mode assertion before continuing.

- [ ] **Step 4: Create the shared auth setup renderer**

Create `nix/lib/jailed-pi-auth.nix`:

```nix
{ lib }:
{
  mkAuthSetup =
    {
      authMode,
      globalAuthPathExpr ? ''"$HOME/.pi/agent/auth.json"'',
    }:
    assert lib.assertMsg (builtins.elem authMode [
      "global"
      "local"
    ]) "jailed Pi authMode must be either \"global\" or \"local\"";
    ''
      global_auth=${globalAuthPathExpr}
      auth_path="$agent_dir/auth.json"

      jailed_pi_auth_conflict() {
        echo "jailed Pi global auth mode will not replace $auth_path; move or remove it before enabling global auth" >&2
        exit 1
      }

      case ${lib.escapeShellArg authMode} in
        global)
          if [ -L "$auth_path" ]; then
            if [ "$(readlink "$auth_path")" != "$global_auth" ]; then
              jailed_pi_auth_conflict
            fi
          elif [ -e "$auth_path" ]; then
            jailed_pi_auth_conflict
          fi

          mkdir -p "$(dirname "$global_auth")"
          touch "$global_auth"
          if [ ! -L "$auth_path" ]; then
            ln -s "$global_auth" "$auth_path"
          fi
          ;;
        local)
          if [ -L "$auth_path" ] && [ "$(readlink "$auth_path")" = "$global_auth" ]; then
            rm "$auth_path"
          fi
          ;;
      esac
    '';
}
```

This helper receives shell path syntax rather than credential contents. It validates the mode at Nix evaluation and emits only path-management commands.

- [ ] **Step 5: Add `authMode` to `projectPiShellHook` and use the helper**

In `modules/lib/project-pi.nix`, extend both jailed defaults:

```nix
          jailedPi ? {
            enable = false;
            agentDir = ".pi/agent-jailed";
            authMode = "global";
          },
```

```nix
          jailedPiCfg = {
            enable = false;
            agentDir = ".pi/agent-jailed";
            authMode = "global";
          }
          // jailedPi;

          authSetupLib = import ../../nix/lib/jailed-pi-auth.nix { lib = pkgs.lib; };
          authSetupScript = authSetupLib.mkAuthSetup {
            inherit (jailedPiCfg) authMode;
          };
```

Validate the project-hook interface immediately before returning the shell string:

```nix
        in
        assert pkgs.lib.assertMsg (builtins.elem jailedPiCfg.authMode [
          "global"
          "local"
        ]) "projectPiShellHook jailedPi.authMode must be either \"global\" or \"local\"";
        ''
```

Within the jailed shell block, keep global sessions but remove the unconditional auth creation:

```nix
            agent_dir=${pkgs.lib.escapeShellArg jailedPiCfg.agentDir}
            mkdir -p "$agent_dir"
            mkdir -p "$HOME/.pi/agent/sessions"
```

After linking immutable resources, replace the current auth/session lines with:

```nix
            ${authSetupScript}
            ln -sfn "$HOME/.pi/agent/sessions" "$agent_dir/sessions"
```

- [ ] **Step 6: Run the focused check and verify filesystem behavior passes**

```bash
nix build --impure --no-link --expr \
  "(builtins.getFlake \"path:$PWD\").checks.x86_64-linux.jailed-pi-auth-mode"
```

Expected: PASS and produce the `jailed-pi-auth-mode-check` derivation.

- [ ] **Step 7: Format and commit the shared setup and project interface**

```bash
nix fmt -- nix/lib/jailed-pi-auth.nix modules/lib/project-pi.nix modules/checks/jailed-pi-auth-mode.nix
git diff --check
git add nix/lib/jailed-pi-auth.nix modules/lib/project-pi.nix modules/checks/jailed-pi-auth-mode.nix
git commit -m "feat(jailed-pi): add safe auth setup modes"
```

---

### Task 2: Jailed Builder Credential Boundary

**Files:**
- Modify: `modules/lib/jailed-pi.nix:53-70,160-175`
- Modify: `modules/checks/jailed-pi-auth-mode.nix`

**Interfaces:**
- Consumes: `authMode = "global" | "local"`.
- Produces: `mkJailedPi { authMode ? "global"; ... } -> package`.
- Guarantees: default/global packages include the global auth permission; local packages omit it while retaining the runtime agent directory and global sessions permissions.

- [ ] **Step 1: Extend the check with generated wrapper-artifact assertions**

Add these bindings before `invalidProjectHook` in `modules/checks/jailed-pi-auth-mode.nix`:

```nix
      fakePi = pkgs.writeShellApplication {
        name = "pi";
        text = ''
          exit 0
        '';
      };

      fakeAgentConfig = pkgs.runCommand "jailed-pi-auth-test-config" { } ''
        mkdir -p "$out"
      '';

      mkTestJailed =
        name: args:
        self'.lib.mkJailedPi (
          {
            inherit name;
            piPackage = fakePi;
            agentConfigPackage = fakeAgentConfig;
            extraPkgs = [ ];
            runtimeClosurePkgs = [ ];
          }
          // args
        );

      defaultJailed = mkTestJailed "jailed-pi-auth-default-test" { };
      globalJailed = mkTestJailed "jailed-pi-auth-global-test" { authMode = "global"; };
      localJailed = mkTestJailed "jailed-pi-auth-local-test" { authMode = "local"; };
      invalidBuilder = builtins.tryEval (
        mkTestJailed "jailed-pi-auth-invalid-test" { authMode = "invalid"; }
      );
```

Add another Nix assertion before `pkgs.runCommand`:

```nix
        assert !invalidBuilder.success;
```

Add these artifact checks near the start of the runCommand shell:

```bash
        assert_contains_global_auth() {
          package="$1"
          if ! grep -R -F -- '$HOME/.pi/agent/auth.json' "$package" >/dev/null; then
            echo "expected $package to contain the global auth permission" >&2
            exit 1
          fi
        }

        assert_omits_global_auth() {
          package="$1"
          if grep -R -F -- '$HOME/.pi/agent/auth.json' "$package" >/dev/null; then
            echo "expected $package to omit the global auth permission" >&2
            exit 1
          fi
        }

        assert_contains_global_auth ${defaultJailed}
        assert_contains_global_auth ${globalJailed}
        assert_omits_global_auth ${localJailed}
```

- [ ] **Step 2: Run the focused check and verify the builder interface fails**

```bash
nix build .#checks.x86_64-linux.jailed-pi-auth-mode --no-link
```

Expected: FAIL during evaluation because `mkJailedPi` does not yet accept `authMode`.

- [ ] **Step 3: Add the validated builder argument**

In the `mkJailedPi` argument set in `modules/lib/jailed-pi.nix`, add the mode after `defaultAgentDir`:

```nix
          defaultAgentDir ? "$HOME/.pi/agent-jailed",
          authMode ? "global",
          apiKeys ? { },
```

Add mode validation before the existing git identity assertion:

```nix
        assert lib.assertMsg (builtins.elem authMode [
          "global"
          "local"
        ]) "mkJailedPi authMode must be either \"global\" or \"local\"";
        assert (gitUserName == null) == (gitUserEmail == null);
```

- [ ] **Step 4: Make the global auth permission conditional**

Split the base jail permission list immediately after the resolved agent-directory permission:

```nix
            [
              network
              time-zone
              no-new-session
              mount-cwd
              (readwrite (noescape ''"$PI_CODING_AGENT_DIR"''))
            ]
            ++ lib.optional (authMode == "global") (try-readwrite (noescape ''"$HOME/.pi/agent/auth.json"''))
            ++ [
              (try-readwrite (noescape ''"$HOME/.pi/agent/sessions"''))
              (readonly "${agentConfigPackage}")
              (try-fwd-env "EDITOR")
              (try-fwd-env "GIT_EDITOR")
              (try-fwd-env "VISUAL")
              (try-fwd-env "PI_CODING_AGENT_DIR")
            ]
```

Leave all subsequent Docker, Podman, API key, runtime closure, and caller-provided permissions unchanged.

- [ ] **Step 5: Run the focused check and verify builder behavior passes**

```bash
nix build .#checks.x86_64-linux.jailed-pi-auth-mode --no-link
```

Expected: PASS; default/global artifacts contain the global auth path, local does not, and invalid mode evaluation fails inside `tryEval`.

- [ ] **Step 6: Format and commit the builder boundary**

```bash
nix fmt -- modules/lib/jailed-pi.nix modules/checks/jailed-pi-auth-mode.nix
git diff --check
git add modules/lib/jailed-pi.nix modules/checks/jailed-pi-auth-mode.nix
git commit -m "feat(jailed-pi): isolate local auth credentials"
```

---

### Task 3: Home Manager Option and Propagation

**Files:**
- Modify: `modules/home/jailed-pi.nix:35-65,90-115,195-224`
- Modify: `modules/checks/jailed-pi-auth-mode.nix`

**Interfaces:**
- Consumes: `programs.roche-pi.jailed.authMode`.
- Produces: a Home Manager enum option defaulting to `"global"`.
- Propagates: the selected mode to both the activation helper and `mkJailedPi`.

- [ ] **Step 1: Add Home Manager evaluation fixtures to the check**

Change the check module header and per-system arguments to receive the flake and system:

```nix
{ inputs, self, ... }:
{
  perSystem =
    {
      pkgs,
      self',
      ...
    }:
```

Add these bindings after the builder fixtures:

```nix
      mkHome =
        {
          packageName,
          authMode ? null,
        }:
        inputs.home-manager.lib.homeManagerConfiguration {
          inherit pkgs;
          modules = [
            self.homeModules.pi
            self.homeModules."jailed-pi"
            {
              home.username = "jailed-pi-auth-test";
              home.homeDirectory = "/home/jailed-pi-auth-test";
              home.stateVersion = "25.11";

              programs.roche-pi = {
                enable = true;
                installNotionCli = false;
                jailed = {
                  enable = true;
                  inherit packageName;
                }
                // pkgs.lib.optionalAttrs (authMode != null) { inherit authMode; };
              };
            }
          ];
        };

      defaultHome = mkHome { packageName = "jailed-pi-home-default-test"; };
      localHome = mkHome {
        packageName = "jailed-pi-home-local-test";
        authMode = "local";
      };
      invalidHome = builtins.tryEval (
        (mkHome {
          packageName = "jailed-pi-home-invalid-test";
          authMode = "invalid";
        }).config.programs.roche-pi.jailed.authMode
      );

      findHomePackage =
        packageName: home:
        let
          matches = builtins.filter (package: pkgs.lib.getName package == packageName) home.config.home.packages;
        in
        assert pkgs.lib.assertMsg (builtins.length matches == 1) "expected one Home Manager package named ${packageName}";
        builtins.head matches;

      defaultHomeJailed = findHomePackage "jailed-pi-home-default-test" defaultHome;
      localHomeJailed = findHomePackage "jailed-pi-home-local-test" localHome;
```

Add these assertions before `pkgs.runCommand`:

```nix
        assert defaultHome.config.programs.roche-pi.jailed.authMode == "global";
        assert localHome.config.programs.roche-pi.jailed.authMode == "local";
        assert !invalidHome.success;
```

Add these artifact assertions in the shell body:

```bash
        assert_contains_global_auth ${defaultHomeJailed}
        assert_omits_global_auth ${localHomeJailed}
```

- [ ] **Step 2: Run the check and capture the Home Manager evaluation failures**

```bash
nix build .#checks.x86_64-linux.jailed-pi-auth-mode --no-link
```

Expected: FAIL. Direct Home Manager evaluation first exposes the captured outer `lib` lacking `lib.hm`; after Step 3, rerunning should fail because `programs.roche-pi.jailed.authMode` is not yet declared.

- [ ] **Step 3: Use Home Manager's augmented `lib` inside the nested module**

Change the nested module arguments in `modules/home/jailed-pi.nix` from:

```nix
    { config, pkgs, ... }:
```

to:

```nix
    {
      config,
      lib,
      pkgs,
      ...
    }:
```

This deliberately shadows the outer flake-module `lib` only within the Home Manager module, making `lib.hm.dag.entryAfter` available through Home Manager's augmented library.

Rerun:

```bash
nix build .#checks.x86_64-linux.jailed-pi-auth-mode --no-link
```

Expected: FAIL because the auth mode option is still undeclared.

- [ ] **Step 4: Add the typed Home Manager option and shared setup binding**

After `agentDir`, add:

```nix
        authMode = mkOption {
          type = types.enum [
            "global"
            "local"
          ];
          default = "global";
          description = "Whether jailed Pi shares global authentication or stores authentication in its agent directory.";
        };
```

In the nested module `let`, after `homeDir`, import and render the shared setup:

```nix
      authSetupLib = import ../../nix/lib/jailed-pi-auth.nix { inherit lib; };
      authSetupScript = authSetupLib.mkAuthSetup {
        inherit (cfg) authMode;
        globalAuthPathExpr = lib.escapeShellArg "${homeDir}/.pi/agent/auth.json";
      };
```

- [ ] **Step 5: Switch activation to mode-aware auth setup and propagate the builder argument**

Keep sessions unconditional, but remove the global auth `touch` from activation:

```nix
          mkdir -p ${lib.escapeShellArg homeDir}/.pi/agent/sessions

          mkdir -p "$agent_dir"
```

After the immutable resource links, replace the forced auth link with the rendered setup while retaining the sessions link:

```nix
          ${authSetupScript}
          ln -sfnT ${lib.escapeShellArg homeDir}/.pi/agent/sessions "$agent_dir/sessions"
```

Pass the mode to `mkJailedPi` after `defaultAgentDir`:

```nix
            defaultAgentDir = cfg.agentDir;
            authMode = cfg.authMode;
            apiKeys = cfg.apiKeys;
```

- [ ] **Step 6: Run the focused check and verify Home Manager propagation passes**

```bash
nix build .#checks.x86_64-linux.jailed-pi-auth-mode --no-link
```

Expected: PASS; the Home option defaults to global, accepts local, rejects invalid, and produces a local wrapper without the global auth permission.

- [ ] **Step 7: Format and commit the Home Manager interface**

```bash
nix fmt -- modules/home/jailed-pi.nix modules/checks/jailed-pi-auth-mode.nix
git diff --check
git add modules/home/jailed-pi.nix modules/checks/jailed-pi-auth-mode.nix
git commit -m "feat(jailed-pi): expose authentication mode"
```

---

### Task 4: User Documentation and Final Verification

**Files:**
- Modify: `README.md:22-49,64-90`

**Interfaces:**
- Documents: the default global mode, local mode, shared-session behavior, and the need to select local mode on both project APIs.

- [ ] **Step 1: Document the Home Manager option**

Add the option to the jailed Home Manager example:

```nix
    jailed = {
      enable = true;
      authMode = "local"; # keep auth.json in the resolved agent directory
      apiKeys = {
```

After the example, add:

```markdown
`jailed.authMode` defaults to `"global"`, which links jailed Pi to `~/.pi/agent/auth.json`. Set it to `"local"` to let the resolved `PI_CODING_AGENT_DIR` own `auth.json` and keep the global credential outside the jail. Sessions remain shared through `~/.pi/agent/sessions` in both modes.
```

- [ ] **Step 2: Document aligned project-shell configuration**

Add `authMode = "local";` to the `mkJailedPi` example after `defaultAgentDir`, and replace the shell-hook shorthand with:

```nix
      jailedPi = {
        enable = true;
        authMode = "local";
      };
```

After the project shell example, add:

```markdown
Use the same `authMode` for `mkJailedPi` and `projectPiShellHook.jailedPi`. Local mode works with `pi-local-auth`: authentication remains under `.pi/local-agent` (or another runtime `PI_CODING_AGENT_DIR`) while sessions continue to use `~/.pi/agent/sessions`.
```

- [ ] **Step 3: Run direct formatting and focused verification**

```bash
nix fmt -- modules/checks/jailed-pi-auth-mode.nix modules/home/jailed-pi.nix modules/lib/jailed-pi.nix modules/lib/project-pi.nix nix/lib/jailed-pi-auth.nix
git diff --check
nix build .#checks.x86_64-linux.jailed-pi-auth-mode --no-link
```

Expected: formatting exits successfully, `git diff --check` prints nothing, and the focused check builds successfully.

No new automated test is added for README text itself; `git diff --check` and the Nix formatter are the appropriate direct verification for documentation/static formatting.

- [ ] **Step 4: Run the full flake check**

```bash
nix flake check --accept-flake-config --print-build-logs
```

Expected: PASS with all flake checks successful, including `jailed-pi-auth-mode`.

The dedicated extension-load check is already part of the full flake checks. This change does not update Pi, flake inputs, or packaged Pi dependencies, so no additional manual Home Manager-like extension startup probe is required.

- [ ] **Step 5: Review the final diff against the specification**

```bash
base="$(git merge-base main HEAD)"
git status --short
git diff --stat "$base"
git diff "$base" -- \
  nix/lib/jailed-pi-auth.nix \
  modules/checks/jailed-pi-auth-mode.nix \
  modules/lib/project-pi.nix \
  modules/lib/jailed-pi.nix \
  modules/home/jailed-pi.nix \
  README.md
```

Confirm from the diff and check output:

- both interfaces default to global;
- Home Manager uses a typed enum;
- local mode removes only the known global symlink;
- conflict paths are preserved and produce actionable errors;
- sessions remain global in all setup paths;
- local wrappers omit the global auth permission;
- no credential contents or credential-reading commands were introduced.

- [ ] **Step 6: Commit the documentation**

```bash
git add README.md
git commit -m "docs(jailed-pi): explain authentication modes"
```
