# Jailed Pi 1Password and GPG Access Design

## Goal

Allow the Home Manager `jailed-pi` package to use the 1Password CLI and create Git commits signed through the user's existing OpenPGP/GnuPG setup, without broadly exposing the host home or runtime directories.

## Scope

Update `modules/home/jailed-pi.nix` only. The reusable `mkJailedPi` API and its existing public options remain unchanged.

## Packages

Add these packages to the jailed Pi runtime in addition to user-supplied `extraPkgs`:

- `pkgs._1password-cli`, which provides `op`;
- `config.programs.gpg.package`, which provides the same GnuPG implementation selected by Home Manager.

## Filesystem and socket access

Construct jail permissions in the Home Manager module with the existing `jail-nix` combinators, then prepend them to `cfg.extraPermissions`.

Expose only the following host paths:

- `~/.config/op` read-write, so `op` can read and update its normal account and plugin state;
- `~/.gnupg` read-write, so GnuPG can use its configuration, keyrings, trust database, and lock files;
- `~/.config/git` read-only, so Git sees the Home Manager-generated signing configuration;
- `$XDG_RUNTIME_DIR/op-daemon.sock` read-write, for 1Password desktop-app authentication;
- `$XDG_RUNTIME_DIR/gnupg` read-write, for the host `gpg-agent`, `scdaemon`, and related sockets.

Create the required `/run/user` destination hierarchy inside the sandbox before binding runtime sockets. Use optional bind combinators so jailed Pi still starts when 1Password or `gpg-agent` is not running.

Do not expose all of `~/.config`, the complete home directory, or the complete XDG runtime directory.

## Environment

Forward:

- `XDG_RUNTIME_DIR`, so `op` and GnuPG resolve the same host socket paths;
- `GPG_TTY`, when set, so terminal-based pinentry retains the caller's terminal context.

The existing Git identity environment overrides remain in place. Git reads `commit.gpgSign`, `user.signingKey`, `gpg.format`, and the signer path from the exposed Home Manager Git configuration.

Because `~/.config/git/config` may be a symlink into `/nix/store`, append that path to `runtimeStoreClosurePaths`. The existing runtime-closure support resolves the symlink and exposes its Nix store requisites.

## Security considerations

Read-write access to `~/.gnupg` gives jailed Pi access to the user's GnuPG key material and signing agent. Read-write access to `~/.config/op` and the 1Password daemon socket allows authenticated `op` operations. These capabilities are explicitly requested and are narrower than mounting the user's full home or runtime directory.

Git configuration is read-only. Optional socket binds avoid turning missing desktop services into startup failures.

## Verification

This is static Nix configuration, so no new automated test will assert configuration text. Verify behavior directly:

1. Format and check `modules/home/jailed-pi.nix` with the repository's Nix formatter.
2. Evaluate and build a Home Manager configuration with jailed Pi enabled.
3. Smoke-test inside the jail that `op --version` and `gpg --version` execute.
4. Confirm Git resolves the expected signing key and `commit.gpgSign` setting inside the jail.
5. Run `nix flake check --accept-flake-config --print-build-logs`.

A real signed commit may require an interactive 1Password or pinentry confirmation and should be performed by the user after reviewing the implementation.
