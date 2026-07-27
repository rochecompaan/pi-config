# Jailed Pi Git Identity Inheritance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make jailed Pi inherit Git's effective `user.name` and `user.email` from the launch repository without requiring callers to embed personal values in Nix configuration.

**Architecture:** Add a focused Nix library that emits the exact host-side shell setup for resolving and exporting Git identity through `GIT_CONFIG_*`. Exercise that setup behaviorally, then wire it into `mkJailedPi` and forward only the generated variables through jail-nix. Update the Home Manager module to use runtime inheritance by default while preserving its existing read-only signing-configuration mount.

**Tech Stack:** Nix flakes, flake-parts/import-tree, Home Manager modules, jail-nix, POSIX shell, Git, Nix derivation checks.

## Global Constraints

- Resolve identity outside the jail with `git config --includes --get user.name` and `git config --includes --get user.email` in the launch repository.
- Automatic inheritance defaults to enabled and can be disabled with `inheritGitIdentity = false`.
- Existing `gitUserName` and `gitUserEmail` arguments remain a paired explicit override with higher precedence than runtime discovery.
- Never inject a partial automatically discovered identity; when either value is absent, inject neither and preserve Git's native commit error.
- Use `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_0`, `GIT_CONFIG_VALUE_0`, `GIT_CONFIG_KEY_1`, and `GIT_CONFIG_VALUE_1` so both `git config` and `git commit` observe the identity.
- Automatic inheritance must not add a host Git configuration mount or embed discovered personal values in a Nix store path.
- Preserve the Home Manager module's existing read-only `~/.config/git` permission and store-closure exposure used for commit signing.
- Automated checks must execute the same runtime setup string interpolated into the production launcher; source-text assertions alone are insufficient.
- New Nix files must be staged before normal git-backed flake commands can see them.
- Keep identity resolution in a focused module rather than growing `modules/lib/jailed-pi.nix` beyond its sandbox-builder responsibility.

## File Structure

- Create `nix/lib/jailed-pi-git-identity.nix`: own identity lookup, transport-variable clearing, explicit override export, and the list of environment variables the sandbox must forward.
- Create `modules/checks/jailed-pi-git-identity.nix`: execute the production setup string against temporary global, local, conditional, missing, disabled, and explicit configurations.
- Create `modules/checks/jailed-pi-git-identity-wiring.nix`: verify `mkJailedPi` selects the correct setup mode, forwards every transport variable, and adds no Git-config mount.
- Create `modules/checks/jailed-pi-git-identity-home.nix`: verify Home Manager defaults/opt-out, removal of build-time identity injection, and preservation of signing-config access.
- Modify `modules/lib/jailed-pi.nix`: add the public option, call the focused setup library in the outer launcher, and forward the transport variables.
- Modify `modules/home/jailed-pi.nix`: expose the boolean option, stop deriving command-scope identity from `programs.git.settings.user`, and pass runtime inheritance to the builder.
- Use `docs/specs/2026-07-27-jailed-pi-git-identity-design.md` as the authoritative behavior contract.

---

### Task 1: Build and behaviorally test the runtime identity setup

**Files:**
- Create: `nix/lib/jailed-pi-git-identity.nix`
- Create: `modules/checks/jailed-pi-git-identity.nix`

**Interfaces:**
- Produces: `envNames :: [ string ]`, the five `GIT_CONFIG_*` variables that jail-nix must forward.
- Produces: `mkSetupScript :: { inheritGitIdentity :: bool, gitUserName :: null|string, gitUserEmail :: null|string } -> string`, a shell fragment safe under `set -euo pipefail`.
- Consumes: `pkgs.git` for host-side effective configuration lookup and `lib.escapeShellArg` for explicit values.

- [ ] **Step 1: Create the failing behavioral check**

Create `modules/checks/jailed-pi-git-identity.nix` with the following complete content:

```nix
{ ... }:
{
  perSystem =
    { pkgs, ... }:
    let
      gitIdentityLib = import ../../nix/lib/jailed-pi-git-identity.nix {
        inherit (pkgs) lib;
        inherit pkgs;
      };

      mkProbe =
        name: args:
        pkgs.writeShellApplication {
          inherit name;
          text = ''
            isolated_home="$1"

            ${gitIdentityLib.mkSetupScript args}

            export HOME="$isolated_home"
            export GIT_CONFIG_NOSYSTEM=1
            unset GIT_CONFIG_GLOBAL
            cd "$isolated_home"

            resolved_name="$(${pkgs.git}/bin/git config --get user.name 2>/dev/null || true)"
            resolved_email="$(${pkgs.git}/bin/git config --get user.email 2>/dev/null || true)"

            printf 'name=%s\n' "''${resolved_name:-<unset>}"
            printf 'email=%s\n' "''${resolved_email:-<unset>}"
            printf 'count=%s\n' "''${GIT_CONFIG_COUNT-<unset>}"
          '';
        };

      inheritedProbe = mkProbe "jailed-pi-git-identity-inherited-probe" {
        inheritGitIdentity = true;
        gitUserName = null;
        gitUserEmail = null;
      };

      disabledProbe = mkProbe "jailed-pi-git-identity-disabled-probe" {
        inheritGitIdentity = false;
        gitUserName = null;
        gitUserEmail = null;
      };

      explicitProbe = mkProbe "jailed-pi-git-identity-explicit-probe" {
        inheritGitIdentity = true;
        gitUserName = ''Explicit "Name" $HOME'';
        gitUserEmail = "explicit+test@example.com";
      };
    in
    {
      checks."jailed-pi-git-identity" = pkgs.runCommand "jailed-pi-git-identity-check" {
        nativeBuildInputs = [ pkgs.git ];
      } ''
        set -eu

        assert_probe() {
          probe="$1"
          source_home="$2"
          source_repo="$3"
          expected_name="$4"
          expected_email="$5"
          expected_count="$6"
          isolated_home="$TMPDIR/isolated-home-$7"
          mkdir -p "$isolated_home"

          actual="$(
            export HOME="$source_home"
            export GIT_CONFIG_NOSYSTEM=1
            cd "$source_repo"
            "$probe" "$isolated_home"
          )"

          expected="$(printf 'name=%s\nemail=%s\ncount=%s' \
            "$expected_name" "$expected_email" "$expected_count")"

          if [ "$actual" != "$expected" ]; then
            echo "unexpected probe output" >&2
            printf 'expected:\n%s\nactual:\n%s\n' "$expected" "$actual" >&2
            exit 1
          fi
        }

        global_home="$TMPDIR/global-home"
        global_repo="$TMPDIR/global-repo"
        mkdir -p "$global_home" "$global_repo"
        git -C "$global_repo" init -q
        git config --file "$global_home/.gitconfig" user.name "Global Name"
        git config --file "$global_home/.gitconfig" user.email "global@example.com"
        assert_probe ${inheritedProbe} "$global_home" "$global_repo" \
          "Global Name" "global@example.com" "2" "global"

        local_repo="$TMPDIR/local-repo"
        git clone -q "$global_repo" "$local_repo"
        local_name='Repo "Name" $HOME'
        git -C "$local_repo" config user.name "$local_name"
        git -C "$local_repo" config user.email "repo+test@example.com"
        assert_probe ${inheritedProbe} "$global_home" "$local_repo" \
          "$local_name" "repo+test@example.com" "2" "local"

        conditional_home="$TMPDIR/conditional-home"
        conditional_repo="$TMPDIR/conditional-repo"
        mkdir -p "$conditional_home" "$conditional_repo"
        git -C "$conditional_repo" init -q
        cat > "$conditional_home/.gitconfig" <<EOF
        [user]
          name = Global Fallback
          email = fallback@example.com
        [includeIf "gitdir:$conditional_repo/"]
          path = $conditional_home/repository-identity.gitconfig
        EOF
        cat > "$conditional_home/repository-identity.gitconfig" <<'EOF'
        [user]
          name = Conditional Name
          email = conditional@example.com
        EOF
        assert_probe ${inheritedProbe} "$conditional_home" "$conditional_repo" \
          "Conditional Name" "conditional@example.com" "2" "conditional"

        assert_probe ${disabledProbe} "$global_home" "$global_repo" \
          "<unset>" "<unset>" "<unset>" "disabled"

        partial_home="$TMPDIR/partial-home"
        partial_repo="$TMPDIR/partial-repo"
        mkdir -p "$partial_home" "$partial_repo"
        git -C "$partial_repo" init -q
        git config --file "$partial_home/.gitconfig" user.name "Name Only"
        assert_probe ${inheritedProbe} "$partial_home" "$partial_repo" \
          "<unset>" "<unset>" "<unset>" "partial"

        broken_home="$TMPDIR/broken-home"
        broken_repo="$TMPDIR/broken-repo"
        broken_config="$TMPDIR/broken-config"
        mkdir -p "$broken_home" "$broken_repo" "$broken_config"
        git -C "$broken_repo" init -q
        (
          export GIT_CONFIG_GLOBAL="$broken_config"
          assert_probe ${inheritedProbe} "$broken_home" "$broken_repo" \
            "<unset>" "<unset>" "<unset>" "broken"
        )

        assert_probe ${explicitProbe} "$partial_home" "$partial_repo" \
          'Explicit "Name" $HOME' "explicit+test@example.com" "2" "explicit"

        touch "$out"
      '';
    };
}
```

- [ ] **Step 2: Stage the new check and run it to verify RED**

Run:

```sh
git add modules/checks/jailed-pi-git-identity.nix
nix build .#checks.x86_64-linux.jailed-pi-git-identity --no-link
```

Expected: FAIL during evaluation because `nix/lib/jailed-pi-git-identity.nix` does not exist. This confirms the new check is visible to the git-backed flake and fails for the missing production interface.

- [ ] **Step 3: Create the minimal runtime setup library**

Create `nix/lib/jailed-pi-git-identity.nix`:

```nix
{ lib, pkgs }:
let
  envNames = [
    "GIT_CONFIG_COUNT"
    "GIT_CONFIG_KEY_0"
    "GIT_CONFIG_VALUE_0"
    "GIT_CONFIG_KEY_1"
    "GIT_CONFIG_VALUE_1"
  ];

  unsetTransport = ''
    unset ${lib.concatStringsSep " " envNames}
  '';
in
{
  inherit envNames;

  mkSetupScript =
    {
      inheritGitIdentity ? true,
      gitUserName ? null,
      gitUserEmail ? null,
    }:
    assert lib.assertMsg (
      (gitUserName == null) == (gitUserEmail == null)
    ) "jailed Pi Git identity requires both gitUserName and gitUserEmail";
    if gitUserName != null then
      ''
        ${unsetTransport}
        export GIT_CONFIG_COUNT=2
        export GIT_CONFIG_KEY_0=user.name
        export GIT_CONFIG_VALUE_0=${lib.escapeShellArg gitUserName}
        export GIT_CONFIG_KEY_1=user.email
        export GIT_CONFIG_VALUE_1=${lib.escapeShellArg gitUserEmail}
      ''
    else if inheritGitIdentity then
      ''
        jailed_pi_git_user_name="$(${lib.getExe pkgs.git} config --includes --get user.name 2>/dev/null || true)"
        jailed_pi_git_user_email="$(${lib.getExe pkgs.git} config --includes --get user.email 2>/dev/null || true)"

        ${unsetTransport}

        if [ -n "$jailed_pi_git_user_name" ] && [ -n "$jailed_pi_git_user_email" ]; then
          export GIT_CONFIG_COUNT=2
          export GIT_CONFIG_KEY_0=user.name
          export GIT_CONFIG_VALUE_0="$jailed_pi_git_user_name"
          export GIT_CONFIG_KEY_1=user.email
          export GIT_CONFIG_VALUE_1="$jailed_pi_git_user_email"
        fi

        unset jailed_pi_git_user_name jailed_pi_git_user_email
      ''
    else
      unsetTransport;
}
```

The lookup occurs before clearing transport variables so an identity supplied through the caller's effective Git environment remains part of the outside-jail resolution. The launcher then replaces those variables with the minimal two-key transport or clears them entirely.

- [ ] **Step 4: Stage the helper, format, and verify GREEN**

Run:

```sh
git add nix/lib/jailed-pi-git-identity.nix
nix fmt -- nix/lib/jailed-pi-git-identity.nix modules/checks/jailed-pi-git-identity.nix
nix build .#checks.x86_64-linux.jailed-pi-git-identity --no-link
```

Expected: PASS. The check must prove global fallback, repository precedence, `includeIf`, opt-out, incomplete/error suppression, explicit precedence, and shell-significant value preservation.

- [ ] **Step 5: Commit the focused runtime behavior**

```sh
git add nix/lib/jailed-pi-git-identity.nix modules/checks/jailed-pi-git-identity.nix
git commit -m "feat(jailed-pi): resolve host Git identity"
```

---

### Task 2: Integrate identity setup with `mkJailedPi`

**Files:**
- Create: `modules/checks/jailed-pi-git-identity-wiring.nix`
- Modify: `modules/lib/jailed-pi.nix:7-229`

**Interfaces:**
- Consumes: `gitIdentityLib.mkSetupScript` and `gitIdentityLib.envNames` from Task 1.
- Produces: `mkJailedPi { inheritGitIdentity ? true; ... }`.
- Preserves: paired `gitUserName` / `gitUserEmail` explicit override arguments.

- [ ] **Step 1: Add a failing builder-wiring check**

Create `modules/checks/jailed-pi-git-identity-wiring.nix`:

```nix
{ ... }:
{
  perSystem =
    { pkgs, self', ... }:
    let
      fakePi = pkgs.writeShellApplication {
        name = "pi";
        text = ''
          exit 0
        '';
      };

      fakeAgentConfig = pkgs.runCommand "jailed-pi-git-identity-test-config" { } ''
        mkdir -p "$out"
      '';

      mkTestJailed =
        name: args:
        self'.lib.mkJailedPi (
          {
            inherit name;
            piPackage = fakePi;
            agentConfigPackage = fakeAgentConfig;
            authMode = "local";
            extraPkgs = [ ];
            runtimeClosurePkgs = [ ];
          }
          // args
        );

      defaultJailed = mkTestJailed "jailed-pi-git-default-test" { };
      disabledJailed = mkTestJailed "jailed-pi-git-disabled-test" {
        inheritGitIdentity = false;
      };
      explicitJailed = mkTestJailed "jailed-pi-git-explicit-test" {
        gitUserName = "Explicit Wiring Name";
        gitUserEmail = "explicit-wiring@example.com";
      };
    in
    {
      checks."jailed-pi-git-identity-wiring" = pkgs.runCommand "jailed-pi-git-identity-wiring-check" { } ''
        set -eu

        launcher_for() {
          package="$1"
          find "$package/bin" -maxdepth 1 -type f -print -quit
        }

        sandbox_launcher_for() {
          launcher="$(launcher_for "$1")"
          sed -n 's|^exec \(/nix/store/[^ ]*-sandbox/bin/[^ ]*\) .*|\1|p' "$launcher"
        }

        assert_contains() {
          file="$1"
          needle="$2"
          grep -F -- "$needle" "$file" >/dev/null || {
            echo "expected $file to contain: $needle" >&2
            exit 1
          }
        }

        assert_omits() {
          file="$1"
          needle="$2"
          if grep -F -- "$needle" "$file" >/dev/null; then
            echo "expected $file to omit: $needle" >&2
            exit 1
          fi
        }

        default_launcher="$(launcher_for ${defaultJailed})"
        disabled_launcher="$(launcher_for ${disabledJailed})"
        explicit_launcher="$(launcher_for ${explicitJailed})"

        assert_contains "$default_launcher" "config --includes --get user.name"
        assert_contains "$default_launcher" "config --includes --get user.email"
        assert_omits "$disabled_launcher" "config --includes --get user.name"
        assert_omits "$disabled_launcher" "GIT_CONFIG_VALUE_0="
        assert_omits "$explicit_launcher" "config --includes --get user.name"
        assert_contains "$explicit_launcher" "Explicit Wiring Name"
        assert_contains "$explicit_launcher" "explicit-wiring@example.com"

        for package in ${defaultJailed} ${disabledJailed} ${explicitJailed}; do
          sandbox_launcher="$(sandbox_launcher_for "$package")"
          test -n "$sandbox_launcher"
          for variable in \
            GIT_CONFIG_COUNT \
            GIT_CONFIG_KEY_0 \
            GIT_CONFIG_VALUE_0 \
            GIT_CONFIG_KEY_1 \
            GIT_CONFIG_VALUE_1
          do
            assert_contains "$sandbox_launcher" "$variable"
          done
          assert_omits "$sandbox_launcher" '$HOME/.gitconfig'
          assert_omits "$sandbox_launcher" '$HOME/.config/git'
        done

        touch "$out"
      '';
    };
}
```

- [ ] **Step 2: Stage and run the wiring check to verify RED**

```sh
git add modules/checks/jailed-pi-git-identity-wiring.nix
nix build .#checks.x86_64-linux.jailed-pi-git-identity-wiring --no-link
```

Expected: FAIL during evaluation because `mkJailedPi` does not accept `inheritGitIdentity`, or fail because the default launcher lacks runtime lookup and forwarding.

- [ ] **Step 3: Wire the helper into the builder**

Modify `modules/lib/jailed-pi.nix` as follows.

After `inherit (pkgs) lib;`, import the focused library:

```nix
      gitIdentityLib = import ../../nix/lib/jailed-pi-git-identity.nix {
        inherit lib pkgs;
      };
```

Add the new argument immediately before the explicit pair:

```nix
          inheritGitIdentity ? true,
          gitUserName ? null,
          gitUserEmail ? null,
```

Inside the builder's `let`, add:

```nix
          gitIdentitySetup = gitIdentityLib.mkSetupScript {
            inherit inheritGitIdentity gitUserName gitUserEmail;
          };
```

Delete the complete `git-identity-env = compose [ ... ];` custom combinator. The focused outer-launcher setup replaces it.

After the existing base environment forwarding list, forward the transport names:

```nix
            ++ map try-fwd-env gitIdentityLib.envNames
```

Delete this old sandbox fragment:

```nix
            ++ lib.optionals (gitUserName != null) [ git-identity-env ]
```

In the final outer `pkgs.writeShellApplication`, add Git to `runtimeInputs`:

```nix
          runtimeInputs = [
            pkgs.coreutils
            pkgs.git
          ];
```

Insert the production setup after `PI_CODING_AGENT_DIR` is exported and before container-specific setup:

```nix
            ${gitIdentitySetup}
```

Do not add `~/.gitconfig`, `~/.config/git`, or any included configuration path to the reusable builder's permissions.

- [ ] **Step 4: Format and verify the focused checks**

```sh
nix fmt -- modules/lib/jailed-pi.nix modules/checks/jailed-pi-git-identity-wiring.nix
nix build .#checks.x86_64-linux.jailed-pi-git-identity --no-link
nix build .#checks.x86_64-linux.jailed-pi-git-identity-wiring --no-link
```

Expected: both checks PASS. The first proves resolution behavior; the second proves the production launcher and sandbox consume that behavior.

- [ ] **Step 5: Commit builder integration**

```sh
git add modules/lib/jailed-pi.nix modules/checks/jailed-pi-git-identity-wiring.nix
git commit -m "feat(jailed-pi): forward effective Git identity"
```

---

### Task 3: Switch the Home Manager module to runtime identity inheritance

**Files:**
- Create: `modules/checks/jailed-pi-git-identity-home.nix`
- Modify: `modules/home/jailed-pi.nix:44-246`

**Interfaces:**
- Consumes: `mkJailedPi.inheritGitIdentity` from Task 2.
- Produces: `programs.roche-pi.jailed.inheritGitIdentity :: bool`, default `true`.
- Preserves: existing `hostCredentialPermissions` read-only `"$HOME/.config/git"` access and `runtimeStoreClosurePaths` entry for `"$HOME/.config/git/config"`.

- [ ] **Step 1: Add the failing Home Manager behavior check**

Create `modules/checks/jailed-pi-git-identity-home.nix`:

```nix
{ inputs, self, ... }:
{
  perSystem =
    {
      pkgs,
      self',
      system,
      ...
    }:
    let
      homePkgs = import inputs.nixpkgs {
        inherit system;
        config.allowUnfreePredicate = package: pkgs.lib.getName package == "1password-cli";
      };

      mkHome =
        {
          packageName,
          inheritGitIdentity ? null,
        }:
        inputs.home-manager.lib.homeManagerConfiguration {
          pkgs = homePkgs;
          modules = [
            self.homeModules.pi
            self.homeModules."jailed-pi"
            {
              home.username = "jailed-pi-git-identity-test";
              home.homeDirectory = "/home/jailed-pi-git-identity-test";
              home.stateVersion = "25.11";

              programs.git = {
                enable = true;
                settings.user = {
                  name = "Home Manager Embedded Name";
                  email = "home-manager-embedded@example.com";
                };
              };

              programs.roche-pi = {
                enable = true;
                installNotionCli = false;
                jailed = {
                  enable = true;
                  inherit packageName;
                }
                // pkgs.lib.optionalAttrs (inheritGitIdentity != null) {
                  inherit inheritGitIdentity;
                };
              };
            }
          ];
        };

      defaultHome = mkHome { packageName = "jailed-pi-git-home-default-test"; };
      disabledHome = mkHome {
        packageName = "jailed-pi-git-home-disabled-test";
        inheritGitIdentity = false;
      };

      findHomePackage =
        packageName: home:
        let
          matches = builtins.filter (
            package: pkgs.lib.getName package == packageName
          ) home.config.home.packages;
        in
        assert pkgs.lib.assertMsg (
          builtins.length matches == 1
        ) "expected one Home Manager package named ${packageName}";
        builtins.head matches;

      defaultJailed = findHomePackage "jailed-pi-git-home-default-test" defaultHome;
      disabledJailed = findHomePackage "jailed-pi-git-home-disabled-test" disabledHome;
    in
    {
      checks."jailed-pi-git-identity-home" =
        assert defaultHome.config.programs.roche-pi.jailed.inheritGitIdentity;
        assert !disabledHome.config.programs.roche-pi.jailed.inheritGitIdentity;
        pkgs.runCommand "jailed-pi-git-identity-home-check" { } ''
          set -eu

          launcher_for() {
            find "$1/bin" -maxdepth 1 -type f -print -quit
          }

          sandbox_launcher_for() {
            launcher="$(launcher_for "$1")"
            sed -n 's|^exec \(/nix/store/[^ ]*-sandbox/bin/[^ ]*\) .*|\1|p' "$launcher"
          }

          default_launcher="$(launcher_for ${defaultJailed})"
          disabled_launcher="$(launcher_for ${disabledJailed})"
          default_sandbox="$(sandbox_launcher_for ${defaultJailed})"
          disabled_sandbox="$(sandbox_launcher_for ${disabledJailed})"

          grep -F "config --includes --get user.name" "$default_launcher" >/dev/null
          if grep -F "config --includes --get user.name" "$disabled_launcher" >/dev/null; then
            echo "disabled Home Manager wrapper unexpectedly resolves host identity" >&2
            exit 1
          fi

          for file in "$default_launcher" "$disabled_launcher" "$default_sandbox" "$disabled_sandbox"; do
            if grep -F "Home Manager Embedded Name" "$file" >/dev/null; then
              echo "Home Manager identity was embedded in $file" >&2
              exit 1
            fi
            if grep -F "home-manager-embedded@example.com" "$file" >/dev/null; then
              echo "Home Manager email was embedded in $file" >&2
              exit 1
            fi
          done

          grep -F '$HOME/.config/git' "$default_sandbox" >/dev/null
          grep -F '$HOME/.config/git' "$disabled_sandbox" >/dev/null
          test -x ${defaultHome.activationPackage}/activate
          test -x ${disabledHome.activationPackage}/activate

          touch "$out"
        '';
    };
}
```

- [ ] **Step 2: Stage and run the Home Manager check to verify RED**

```sh
git add modules/checks/jailed-pi-git-identity-home.nix
nix build .#checks.x86_64-linux.jailed-pi-git-identity-home --no-link
```

Expected: FAIL because `programs.roche-pi.jailed.inheritGitIdentity` is not defined. If evaluation reaches the shell check, it must fail because the Home Manager identity is still embedded as a command-scope override.

- [ ] **Step 3: Add the Home Manager option and remove implicit build-time identity**

In `modules/home/jailed-pi.nix`, remove:

```nix
      gitUserName = config.programs.git.settings.user.name or null;
      gitUserEmail = config.programs.git.settings.user.email or null;
```

Add this option immediately after `authMode`:

```nix
        inheritGitIdentity = mkOption {
          type = types.bool;
          default = true;
          description = "Whether jailed Pi inherits Git's effective name and email from the launch repository.";
        };
```

Remove the assertion that requires both `programs.git.settings.user.name` and `programs.git.settings.user.email`. Identity is no longer read from those Home Manager values during Nix evaluation.

Replace this builder wiring:

```nix
            inherit gitUserName gitUserEmail;
```

with:

```nix
            inheritGitIdentity = cfg.inheritGitIdentity;
```

Do not change either of these existing signing-config lines:

```nix
        (try-readonly (noescape ''"$HOME/.config/git"''))
```

```nix
            runtimeStoreClosurePaths = cfg.runtimeStoreClosurePaths ++ [ ''"$HOME/.config/git/config"'' ];
```

- [ ] **Step 4: Format and run focused Home Manager checks**

```sh
nix fmt -- modules/home/jailed-pi.nix modules/checks/jailed-pi-git-identity-home.nix
nix build .#checks.x86_64-linux.jailed-pi-git-identity-home --no-link
nix build .#checks.x86_64-linux.jailed-pi-auth-mode --no-link
```

Expected: both checks PASS. The new check proves default/opt-out runtime behavior and signing-config preservation; the existing auth check proves unrelated credential boundaries remain intact.

- [ ] **Step 5: Commit Home Manager integration**

```sh
git add modules/home/jailed-pi.nix modules/checks/jailed-pi-git-identity-home.nix
git commit -m "feat(jailed-pi): inherit repository Git identity"
```

---

### Task 4: Verify an actual jailed commit and the complete flake

**Files:**
- No repository files changed.
- Temporary verification expression: `/tmp/jailed-pi-git-identity-probe.nix`

**Interfaces:**
- Consumes: completed `mkJailedPi` implementation and all focused checks.
- Produces: evidence that Git inside a real jail observes an outside `includeIf` identity and successfully commits.

- [ ] **Step 1: Run every focused Git identity check together**

```sh
nix build \
  .#checks.x86_64-linux.jailed-pi-git-identity \
  .#checks.x86_64-linux.jailed-pi-git-identity-wiring \
  .#checks.x86_64-linux.jailed-pi-git-identity-home \
  --no-link
```

Expected: all three derivations build successfully.

- [ ] **Step 2: Create a fake Pi that performs Git operations inside the real jail**

Write `/tmp/jailed-pi-git-identity-probe.nix`:

```nix
let
  flake = builtins.getFlake "path:/home/roche/projects/pi/roche-pi/.worktrees/jailed-pi-git-identity";
  system = "x86_64-linux";
  pkgs = import flake.inputs.nixpkgs { inherit system; };

  fakePi = pkgs.writeShellApplication {
    name = "pi";
    runtimeInputs = [ pkgs.git ];
    text = ''
      actual_name="$(git config --get user.name)"
      actual_email="$(git config --get user.email)"
      test "$actual_name" = "$EXPECTED_GIT_NAME"
      test "$actual_email" = "$EXPECTED_GIT_EMAIL"

      printf '%s\n' "proof" > jailed-git-identity-proof.txt
      git add jailed-git-identity-proof.txt
      git commit -m "test: verify jailed Git identity"
      git log -1 --format='%an <%ae>'
    '';
  };

  fakeAgentConfig = pkgs.runCommand "jailed-pi-git-identity-probe-config" { } ''
    mkdir -p "$out"
  '';
in
flake.lib.${system}.mkJailedPi {
  name = "jailed-pi-git-identity-probe";
  piPackage = fakePi;
  agentConfigPackage = fakeAgentConfig;
  authMode = "local";
  apiKeys = {
    EXPECTED_GIT_NAME.fromEnv = true;
    EXPECTED_GIT_EMAIL.fromEnv = true;
  };
  extraPkgs = [ ];
  runtimeClosurePkgs = [ ];
}
```

- [ ] **Step 3: Build and run the real-jail commit probe**

```sh
rm -f /tmp/jailed-pi-git-identity-probe
nix build --impure \
  --expr 'import /tmp/jailed-pi-git-identity-probe.nix' \
  --out-link /tmp/jailed-pi-git-identity-probe

probe_root="$(mktemp -d)"
probe_home="$probe_root/home"
probe_repo="$probe_root/repository"
probe_agent="$probe_root/agent"
mkdir -p "$probe_home" "$probe_repo" "$probe_agent"
git -C "$probe_repo" init -q

cat > "$probe_home/.gitconfig" <<EOF
[includeIf "gitdir:$probe_repo/"]
  path = $probe_home/repository-identity.gitconfig
EOF
cat > "$probe_home/repository-identity.gitconfig" <<'EOF'
[user]
  name = Jailed Integration Name
  email = jailed-integration@example.com
EOF

(
  export HOME="$probe_home"
  export PI_CODING_AGENT_DIR="$probe_agent"
  export EXPECTED_GIT_NAME="Jailed Integration Name"
  export EXPECTED_GIT_EMAIL="jailed-integration@example.com"
  cd "$probe_repo"
  /tmp/jailed-pi-git-identity-probe/bin/jailed-pi-git-identity-probe
)

git -C "$probe_repo" log -1 --format='%an <%ae>' | \
  grep -Fx 'Jailed Integration Name <jailed-integration@example.com>'
```

Expected: the fake Pi creates one commit inside the real jail and both the in-jail output and host-side log show `Jailed Integration Name <jailed-integration@example.com>`.

- [ ] **Step 4: Run the mandatory Pi runtime and complete flake checks**

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
```

Expected: both commands exit 0. The full flake check includes the three new Git identity checks and all existing checks.

- [ ] **Step 5: Verify the feature worktree is clean**

```sh
git status --short
git log --oneline --decorate -5
```

Expected: no status output; recent commits include the spec commits and the three focused implementation commits.

---

### Task 5: Validate and roll out the project-specific `clubhouse_infra` wrapper

**Files:**
- Local project configuration: `/home/roche/projects/clubhouse/clubhouse_infra/devenv.nix` (already initializes `.pi/local-agent`; no identity values should be added)
- Local pin after publication: `/home/roche/projects/clubhouse/clubhouse_infra/devenv.lock`

**Interfaces:**
- Consumes: the completed local `roche-pi` worktree through devenv's `--override-input` during pre-merge validation.
- Produces: a project `jailed-pi` wrapper built from the new revision after that revision is published.

- [ ] **Step 1: Build the project wrapper against the local feature worktree**

```sh
cd /home/roche/projects/clubhouse/clubhouse_infra
wrapper="$(
  devenv \
    --override-input roche-pi path:/home/roche/projects/pi/roche-pi/.worktrees/jailed-pi-git-identity \
    shell -- which jailed-pi | tail -1
)"
test -x "$wrapper"
grep -F "config --includes --get user.name" "$wrapper"
grep -F "config --includes --get user.email" "$wrapper"
```

Expected: the override builds successfully and the resolved project wrapper contains both runtime lookups.

- [ ] **Step 2: Confirm the project configuration contains no personal identity**

```sh
if rg -n 'gitUser(Name|Email)|user\.(name|email)|GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL)' devenv.nix; then
  echo "clubhouse_infra must not configure personal Git identity" >&2
  exit 1
fi
```

Expected: `rg` prints nothing and exits 1, so the surrounding `if` exits successfully.

- [ ] **Step 3: After the feature branch is merged and published, update only the `roche-pi` pin**

```sh
cd /home/roche/projects/clubhouse/clubhouse_infra
devenv update roche-pi
python - <<'PY'
import json
from pathlib import Path
lock = json.loads(Path("devenv.lock").read_text())
node = lock["nodes"]["roche-pi"]["locked"]
print(f"roche-pi revision: {node['rev']}")
PY
```

Expected: `devenv.lock` records the published revision containing the implementation commits. Do not run this step before publication; the remote input cannot resolve an unpublished local commit.

- [ ] **Step 4: Re-enter the project shell and perform the original commit smoke test in a disposable repository**

```sh
cd /home/roche/projects/clubhouse/clubhouse_infra
smoke_repo="$PWD/.jailed-pi-git-smoke"
rm -rf "$smoke_repo"
mkdir -p "$smoke_repo"
git -C "$smoke_repo" init -q
printf '%s\n' "test" > "$smoke_repo/test.txt"

echo "Inside Pi, run the bash-mode commands listed in the next step."
devenv shell -- jailed-pi
rm -rf "$smoke_repo"
```

Inside Pi, use bash mode to run:

```text
!cd /home/roche/projects/clubhouse/clubhouse_infra/.jailed-pi-git-smoke && git add test.txt && git commit -m "test"
!git -C /home/roche/projects/clubhouse/clubhouse_infra/.jailed-pi-git-smoke log -1 --format='%an <%ae>'
```

Expected: the commit succeeds without `Author identity unknown`, and the author matches `git config --includes --get user.name` / `user.email` outside the jail for that disposable repository.

Because this final command is an interactive user-facing smoke test, retain the automated real-jail probe from Task 4 as the repeatable regression evidence.
