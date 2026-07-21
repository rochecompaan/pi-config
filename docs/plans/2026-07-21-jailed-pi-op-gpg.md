# Jailed Pi 1Password and GPG Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Home Manager `jailed-pi` package authenticated 1Password CLI access and conventional OpenPGP commit-signing access through the user's existing host configuration and agents.

**Architecture:** Build the required jail-nix permission values in `modules/home/jailed-pi.nix`, then prepend them to the existing `extraPermissions` escape hatch passed to `mkJailedPi`. Add the 1Password CLI and the Home Manager-selected GnuPG package to the jail runtime, expose only the required home paths and XDG runtime sockets, and make the Home Manager Git config's Nix store closure available.

**Tech Stack:** Nix flakes, Home Manager modules, jail-nix/bubblewrap, 1Password CLI, GnuPG, Git.

## Global Constraints

- Modify `modules/home/jailed-pi.nix` only for production behavior.
- Keep the public `mkJailedPi` interface and existing Home Manager options unchanged.
- Do not mount the full home directory, all of `~/.config`, or all of `$XDG_RUNTIME_DIR`.
- Preserve user-provided `extraPkgs`, `extraPermissions`, and `runtimeStoreClosurePaths`.
- Missing 1Password or GnuPG runtime sockets must not prevent jailed Pi from starting.
- Work directly on `main`; the user declined an isolated worktree.
- Do not activate the resulting Home Manager configuration or create a real signed commit without the user's explicit approval.

---

## File Structure

- Modify `modules/home/jailed-pi.nix`: construct the host credential permissions and add packages/runtime closure paths to the jailed Pi builder invocation.
- No automated test file: this is static Nix configuration, which the project Testing Value Gate excludes from configuration-content tests. Use evaluation, build, generated-wrapper inspection, runtime startup, and the existing flake checks instead.

---

### Task 1: Add narrow 1Password and GnuPG access

**Files:**
- Modify: `modules/home/jailed-pi.nix:37-62`
- Modify: `modules/home/jailed-pi.nix:191-206`

**Interfaces:**
- Consumes: `inputs.jail-nix.lib.init pkgs`, `config.programs.gpg.package`, existing `cfg.extraPkgs`, `cfg.extraPermissions`, and `cfg.runtimeStoreClosurePaths`.
- Produces: a `hostCredentialPermissions` list of jail-nix permission functions passed through the existing `mkJailedPi.extraPermissions` argument.

- [ ] **Step 1: Confirm the existing Home Manager module evaluates before the change**

Run:

```bash
repo=$PWD
nix eval --impure --json --expr "
let
  f = builtins.getFlake \"path:$repo\";
  pkgs = import f.inputs.nixpkgs {
    system = \"x86_64-linux\";
    config.allowUnfree = true;
  };
  hm = f.inputs.home-manager.lib.homeManagerConfiguration {
    inherit pkgs;
    modules = [
      f.homeModules.pi
      f.homeModules.\"jailed-pi\"
      {
        home.username = \"jailed-pi-test\";
        home.homeDirectory = \"/home/jailed-pi-test\";
        home.stateVersion = \"25.05\";
        programs.\"roche-pi\".enable = true;
        programs.\"roche-pi\".jailed.enable = true;
        programs.git = {
          enable = true;
          settings.user = {
            name = \"Jailed Pi Test\";
            email = \"jailed-pi@example.invalid\";
          };
          signing = {
            key = \"0123456789ABCDEF\";
            signByDefault = true;
            format = \"openpgp\";
          };
        };
        programs.gpg.enable = true;
      }
    ];
  };
in map (package: package.drvPath) hm.config.home.packages
"
```

Expected: exit 0 and a JSON list containing a derivation whose name ends in `jailed-pi.drv`.

- [ ] **Step 2: Construct the credential permissions**

In the inner module's `let` block, add `credentialJail` after `homeDir` and add `hostCredentialPermissions` after `apiKeyFiles`:

```nix
      homeDir = config.home.homeDirectory;
      credentialJail = inputs.jail-nix.lib.init pkgs;
      gitUserName = config.programs.git.settings.user.name or null;
```

```nix
      hostCredentialPermissions =
        with credentialJail.combinators;
        [
          (unsafe-add-raw-args "--dir /run")
          (unsafe-add-raw-args "--dir /run/user")
          (unsafe-add-raw-args ''--dir "$XDG_RUNTIME_DIR"'')
          (try-fwd-env "XDG_RUNTIME_DIR")
          (try-fwd-env "GPG_TTY")
          (try-readwrite (noescape ''"$HOME/.config/op"''))
          (try-readwrite (noescape ''"$HOME/.gnupg"''))
          (try-readonly (noescape ''"$HOME/.config/git"''))
          (try-readwrite (noescape ''"$XDG_RUNTIME_DIR/op-daemon.sock"''))
          (try-readwrite (noescape ''"$XDG_RUNTIME_DIR/gnupg"''))
        ];
```

The `try-*` combinators produce bubblewrap's optional bind arguments, so missing config directories or sockets remain non-fatal. The three `--dir` arguments create only the parent hierarchy required for the two XDG runtime binds.

- [ ] **Step 3: Add the packages and compose existing extension points**

Replace the `extraPkgs`, `runtimeStoreClosurePaths`, and `extraPermissions` arguments in the `mkJailedPi` call with:

```nix
            extraPkgs =
              [
                pkgs._1password-cli
                config.programs.gpg.package
              ]
              ++ cfg.extraPkgs
              ++ optional (editorPackage != null) editorPackage;
            runtimeStoreClosurePaths = cfg.runtimeStoreClosurePaths ++ [ ''"$HOME/.config/git/config"'' ];
            runtimeClosurePkgs = [ piResources.package ];
            extraPermissions = hostCredentialPermissions ++ cfg.extraPermissions;
```

Keep the surrounding `docker`, `podman`, and other arguments unchanged.

- [ ] **Step 4: Format the modified Nix module**

Run:

```bash
nix fmt -- modules/home/jailed-pi.nix
```

Expected: exit 0. Review `git diff --check -- modules/home/jailed-pi.nix`; expected: exit 0 with no output.

- [ ] **Step 5: Evaluate and build the generated jailed Pi package**

Run:

```bash
repo=$PWD
nix build --impure --out-link result-jailed-pi --expr "
let
  f = builtins.getFlake \"path:$repo\";
  pkgs = import f.inputs.nixpkgs {
    system = \"x86_64-linux\";
    config.allowUnfree = true;
  };
  hm = f.inputs.home-manager.lib.homeManagerConfiguration {
    inherit pkgs;
    modules = [
      f.homeModules.pi
      f.homeModules.\"jailed-pi\"
      {
        home.username = \"jailed-pi-test\";
        home.homeDirectory = \"/home/jailed-pi-test\";
        home.stateVersion = \"25.05\";
        programs.\"roche-pi\".enable = true;
        programs.\"roche-pi\".jailed.enable = true;
        programs.git = {
          enable = true;
          settings.user = {
            name = \"Jailed Pi Test\";
            email = \"jailed-pi@example.invalid\";
          };
          signing = {
            key = \"0123456789ABCDEF\";
            signByDefault = true;
            format = \"openpgp\";
          };
        };
        programs.gpg.enable = true;
      }
    ];
  };
in builtins.head hm.config.home.packages
"
```

Expected: exit 0 and `result-jailed-pi/bin/jailed-pi` exists.

- [ ] **Step 6: Inspect the built closure and generated sandbox wrapper**

Run:

```bash
nix-store --query --requisites ./result-jailed-pi \
  | grep -E '/[^/]*(1password-cli|gnupg)-[^/]*$'

sandbox=$(
  nix-store --query --requisites ./result-jailed-pi \
    | grep -E '/[^/]*-jailed-pi-sandbox$' \
    | head -n 1
)

test -n "$sandbox"
rg -n '(\.config/op|\.gnupg|\.config/git|op-daemon\.sock|XDG_RUNTIME_DIR/gnupg|GPG_TTY|XDG_RUNTIME_DIR)' \
  "$sandbox/bin/jailed-pi-sandbox"
```

Expected:

- the closure query prints both a `1password-cli` and a `gnupg` store path;
- `sandbox` resolves to the generated jailed Pi sandbox package;
- the wrapper contains the three home-path binds, both narrow runtime binds, and forwarding for `GPG_TTY` and `XDG_RUNTIME_DIR`.

- [ ] **Step 7: Smoke-test jailed Pi startup**

Run:

```bash
./result-jailed-pi/bin/jailed-pi --version
```

Expected: exit 0 and the Pi version. There must be no bubblewrap errors for duplicate directories or missing optional sockets.

- [ ] **Step 8: Run the full flake checks**

Run:

```bash
nix flake check --accept-flake-config --print-build-logs
```

Expected: exit 0 with every flake check passing.

The dedicated Pi extension-load check is not required because this change does not update Pi, a flake input, or a packaged Pi extension dependency.

- [ ] **Step 9: Remove the temporary build result and review the change**

Run:

```bash
rm result-jailed-pi
git status --short
git diff --check
git diff -- modules/home/jailed-pi.nix
```

Expected: only `modules/home/jailed-pi.nix` is modified by the implementation, and `git diff --check` reports no whitespace errors.

- [ ] **Step 10: Commit the implementation**

```bash
git add modules/home/jailed-pi.nix
git commit -m "feat(jailed-pi): add op and GPG access"
```

Do not activate Home Manager. Report the commit and verification evidence to the user so they can review before applying it.
