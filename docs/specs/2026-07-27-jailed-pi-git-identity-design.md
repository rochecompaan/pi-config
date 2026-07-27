# Jailed Pi Git Identity Inheritance Design

## Status

Design approved; awaiting review of this written specification.

## Problem

The reusable `mkJailedPi` builder makes Git available inside the jail but does not expose the host's Git configuration. A repository without local `user.name` and `user.email` therefore cannot create commits unless every `mkJailedPi` caller supplies `gitUserName` and `gitUserEmail` explicitly.

That requirement duplicates identity already configured on the host and prevents conditional Git configuration from selecting the identity appropriate for the current repository. Mounting the host's complete Git configuration would solve the immediate error but would also expose unrelated aliases, credential helpers, signing configuration, URL rewrites, and include paths to the jail.

## Goals

- Let jailed Git commits use the same effective name and email as Git outside the jail.
- Resolve identity in the current repository so repository-local settings and `includeIf` rules are honored.
- Make automatic inheritance the default for `mkJailedPi` callers.
- Forward only the resolved name and email, not host Git configuration files.
- Preserve `gitUserName` and `gitUserEmail` as explicit overrides.
- Permit callers to disable automatic inheritance.
- Preserve Git's native missing-identity failure when the host has no complete effective identity.

## Non-goals

- Adding Git configuration mounts to the reusable builder or broadening the Home Manager module's existing read-only `~/.config/git` mount used for commit signing.
- Forwarding aliases, credential helpers, URL rewrites, hooks, signing keys, signing programs, or other Git settings.
- Changing repository-local `.git/config`; the mounted working tree already makes it visible to Git inside the jail.
- Synthesizing an identity when the host has not configured both name and email.
- Changing commit signing behavior.
- Removing the existing explicit identity arguments.

## Public interface

Add automatic identity inheritance to the reusable builder:

```nix
mkJailedPi {
  inheritGitIdentity ? true;
  gitUserName ? null;
  gitUserEmail ? null;
  # ...
}
```

Expose the same opt-out through the Home Manager module:

```nix
programs.roche-pi.jailed.inheritGitIdentity = true;
```

The option defaults to `true`. Direct project callers, including `clubhouse_infra`, receive host identity inheritance without specifying a name or email.

The existing assertion remains: `gitUserName` and `gitUserEmail` must either both be set or both be `null`.

## Precedence

Identity selection follows this order:

1. When both `gitUserName` and `gitUserEmail` are provided, inject those explicit values.
2. Otherwise, when `inheritGitIdentity = true`, resolve the effective host values at launcher runtime.
3. Otherwise, inject no identity.

Explicit values therefore remain deterministic overrides and do not depend on the launch directory. Setting `inheritGitIdentity = false` affects only automatic discovery; it does not suppress an explicit pair.

## Runtime resolution

Automatic discovery runs in the outer launcher before entering the jail, while the launcher still has access to the host Git configuration and the original working directory.

It resolves:

```sh
git config --includes --get user.name
git config --includes --get user.email
```

Running without `--global` deliberately asks Git for the effective configuration in the current repository. This honors, in Git's normal precedence order:

- repository-local `.git/config`;
- worktree configuration where enabled;
- matching `includeIf` configuration;
- global and system fallback values.

The launcher injects identity only when both commands produce non-empty values. If either value is absent or resolution fails, it injects neither and continues launching Pi. A later `git commit` then reports Git's normal missing-identity error.

## Jail data flow

The outer launcher converts the resolved pair into Git's environment-backed configuration interface:

```text
host Git config
    -> outer launcher resolves effective user.name/user.email
    -> GIT_CONFIG_COUNT / GIT_CONFIG_KEY_* / GIT_CONFIG_VALUE_*
    -> jail forwards only those variables
    -> Git inside the jail sees user.name/user.email
```

Using `GIT_CONFIG_*` rather than only `GIT_AUTHOR_*` and `GIT_COMMITTER_*` makes the values visible consistently to Git configuration queries and commit operations. Automatic inheritance adds no host configuration mount. The Home Manager module retains its pre-existing read-only `~/.config/git` mount because Git signing configuration depends on it; the reusable builder does not add that mount.

The automatically generated `GIT_CONFIG_*` values are private launcher-to-jail transport. They replace any same-named outer environment variables because the current jail does not promise to forward caller-supplied environment-backed Git configuration. Existing explicit identity injection continues to use the same Git configuration mechanism.

## Component changes

### Jailed Pi builder

`modules/lib/jailed-pi.nix`:

- accepts `inheritGitIdentity ? true`;
- retains the explicit identity pair and assertion;
- resolves the effective host identity only when no explicit pair is supplied and inheritance is enabled;
- forwards the minimal generated Git configuration variables into the jail;
- includes the host-side Git executable needed for runtime lookup without exposing host configuration paths inside the jail.

The runtime identity setup should be isolated as focused reusable logic so the exact behavior interpolated into the production launcher can be exercised by regression checks.

### Home Manager module

`modules/home/jailed-pi.nix`:

- defines `programs.roche-pi.jailed.inheritGitIdentity` as a boolean defaulting to `true`;
- passes it to `mkJailedPi`;
- stops converting `programs.git.settings.user.name` and `programs.git.settings.user.email` into command-scope overrides for the jailed wrapper;
- preserves the existing read-only `~/.config/git` permission and store-closure exposure required by the jailed commit-signing integration.

The outer launcher instead resolves the effective identity at runtime. This normally produces the same Home Manager-configured global identity while allowing repository-local and conditional configuration to take precedence exactly as it does outside the jail. The explicit builder arguments remain available to direct `mkJailedPi` callers that require deterministic overrides. Existing signing configuration access is unchanged and is not part of the automatic identity transport.

### Project callers

Existing direct callers require no configuration change because inheritance defaults to enabled. A caller that requires identity isolation can set:

```nix
inheritGitIdentity = false;
```

`clubhouse_infra` should update its pinned `roche-pi` revision after the change is available. Its `devenv.nix` should not contain personal name or email values.

## Error handling and security

- Missing or incomplete host identity does not prevent Pi from starting.
- Partial identity is never injected; Git remains responsible for reporting the commit error.
- Explicit partial identity remains a Nix evaluation error, preserving the current contract.
- The jail receives only effective name and email values.
- Automatic identity inheritance does not add or broaden Git configuration mounts. The Home Manager module's existing read-only `~/.config/git` signing configuration remains available by prior design.
- Credential helpers, signing configuration, aliases, URL rewrites, and other settings are not inherited accidentally.
- Automatically inherited identity values are resolved at runtime and therefore do not enter Nix derivations or the Nix store. Callers using the existing explicit identity arguments retain their current build-time behavior.
- Repository-controlled local configuration can influence the selected identity because matching normal host Git behavior is an explicit goal. It cannot use this mechanism to expose other host Git settings.

## Testing

This changes reusable runtime behavior and warrants automated regression coverage. Tests must execute the same runtime identity setup used by the production launcher rather than assert generated Nix or shell source text.

Use temporary homes and repositories to cover:

1. A global name and email are inherited when no repository override exists.
2. Repository-local name and email override global values.
3. A matching `includeIf` identity is inherited.
4. Explicit `gitUserName` and `gitUserEmail` override runtime discovery.
5. `inheritGitIdentity = false` suppresses automatic discovery.
6. A missing name, missing email, command failure, or empty value injects no partial identity.
7. Values containing spaces and shell-significant characters are preserved exactly.
8. The resulting jail environment makes both `git config --get user.name` / `user.email` and a commit probe observe the inherited values.
9. The reusable builder's automatic inheritance does not add a Git configuration mount, while the Home Manager module retains its existing read-only signing-configuration permission.

Complete verification with:

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
```

The extension-load check is required because the implementation changes the jailed Pi wrapper rather than Pi's packaged extensions, but running the repository's standard Pi runtime check ensures the broader packaged configuration still loads after the Nix changes.

For `clubhouse_infra`, directly verify the original failure by creating and committing a temporary file through the project-specific `jailed-pi`, then remove the temporary commit or use a disposable repository so project history is not altered.

## Compatibility

Existing explicit builder identity configurations keep their current values and precedence. Existing callers without explicit values gain automatic inheritance by default. Home Manager users normally observe the same globally configured identity, but repository-local and conditional identities can now override it as they do outside the jail. Callers that intentionally require Git to have no host identity inside the jail must opt out with `inheritGitIdentity = false`.

Automatic inheritance adds no host Git configuration visibility and embeds no personal identity in the Nix store. The Home Manager module's existing read-only signing-configuration mount and the existing build-time behavior of explicit identity arguments remain unchanged.
