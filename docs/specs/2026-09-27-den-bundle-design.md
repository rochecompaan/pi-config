# Den Bundle Design

## Summary

This repository will publish a reusable Den bundle and a ready-to-run `pi-den` package.

The bundle will expose immutable resources for Pi and Claude Code. The `pi-den` package will run this repository's Pi configuration inside Den and Fence.

The packaged Pi configuration will be authoritative. Den will restore each managed path before every Pi launch.

## Goals

- Publish `packages.${system}.den-bundle` with `passthru.denResources`.
- Publish `packages.${system}.pi-den` with a `bin/pi-den` command.
- Expose this repository's complete Pi package set through the bundle.
- Expose compatible skills and the Context Mode MCP server to Claude Code.
- Use the Pi version and tool-result preview patch that Den packages.
- Restore packaged Pi settings and support files before every launch.
- Keep authentication, sessions, caches, and other Pi-owned state mutable.
- Preserve the existing Pi, Home Manager, and development-shell outputs.

## Non-goals

- The bundle will not expose `multi-model-planning-teams`.
- The bundle will not expose `agent-teams` to Pi or Claude Code.
- `pi-den` will not import the host `~/.pi/agent` directory.
- `pi-den` will not copy host credentials into Den state.
- This change will not replace the current Home Manager Pi installation.
- This change will not add Den wrappers for Claude Code.
- This repository will not keep a second Pi patch after Den contains the same patch.
- `pi-den` will not support the `PI_CODING_AGENT_AUTH_FILE` override. Each Den agent directory already has its own `auth.json`.

## Prerequisites

Den must package Pi with the same tool-result preview behavior as this repository. Den's Pi version can differ from this repository's version; see "Version divergence" below.

Den must also provide the managed-state primitive in this design. The implementation must use that primitive instead of an outer seeding script.

Den must accept store-path strings such as `"${pkg}/skills"` as resources. Without this, each subpath needs its own wrapper derivation.

The flake will pin Den as an input after these changes are available. The lock file will identify the exact reviewed Den revision. Den `69a9a20` meets all three requirements and packages Pi 1.0.2.

## Public outputs

### `den-bundle`

`den-bundle` will be a small derivation with `passthru.denResources`. It will not install a command.

Consumers can pass it to either Den agent:

```nix
programs.den.pi.bundles = [ inputs.roche-pi.packages.${system}.den-bundle ];
programs.den.claude.bundles = [ inputs.roche-pi.packages.${system}.den-bundle ];
```

### `pi-den`

`pi-den` will use `inputs.den.lib.${system}.mkPi`. It will expose only `bin/pi-den`, which prevents a collision with the existing `pi` command.

The wrapper will preserve all arguments and the Den process status. Den will continue to select the agent and session directories.

The normal Den path-selection order remains valid:

1. A non-null constructor value.
2. An inherited `PI_CODING_AGENT_DIR` or `PI_CODING_AGENT_SESSION_DIR` value.
3. The Den default under its runtime state directory.

The managed files will apply to the selected agent directory. A custom valid `PI_CODING_AGENT_DIR` will therefore receive the same packaged configuration.

## Pi bundle resources

The Pi resource entry will use Den's `packages` resource class. It will contain, in this order:

- The `pi-config` package from this repository.
- `pi-context-paging`.
- Context Mode.
- `pi-claude-bridge`.
- `pi-codegraph`.
- `pi-listen`.
- `pi-loadout`.
- The Matt Pocock skills package.
- The patched Superpowers package.
- `pi-remote`.
- `pi-subagents`.
- `pi-vim`.
- `remote-pi`.

The entries after `pi-config` are `piDeps.packagePaths`, the same list that `pi-config` uses. Context paging comes first so its context handler runs before the other packages' handlers. The Matt Pocock and Superpowers packages supply skills that `pi-config` no longer contains.

Each entry is a package or a store-path string such as `"${pkg}/lib/node_modules/name"`. The bundle will not wrap entries in extra derivations.

The `pi-config` package already declares this repository's extensions, skills, and themes. Den will discover those resources through Pi's package format.

The bundle will not add direct extension, skill, prompt-template, or theme entries. This keeps the package root authoritative and avoids duplicate discovery.

The Den-specific `settings.json` will not contain a `packages` key. Den's immutable package arguments will supply these resources instead.

## Claude bundle resources

The Claude resource entry will contain compatible skills and the Context Mode MCP server. It will not contain plugins or settings fragments.

The local skill list will contain:

- `commit`
- `frontend-design`
- `github`
- `module-size`
- `nix-config`

The external skill list will contain:

- `codebase-design`, from the Matt Pocock skills package
- `domain-modeling`, from the Matt Pocock skills package
- `simple-english`
- the Superpowers skills
- the Context Mode skills

The Context Mode MCP command will use its immutable Nix store executable. Context Mode will store its data below Den's writable Claude configuration directory.

These skills will remain excluded:

- `gitea`, because the bundle does not provide `tea` or its credentials.
- `linear`, because the bundle does not provide `streamlinear-cli` or its credentials.
- `notion`, because the bundle does not provide mutable Notion credentials.
- `show-me`, because Den does not provide a host browser launcher.
- `subagent-model-profiles`, because it controls the Pi subagent tool.
- `intervals-time-entries`, because it requires Pi-specific tools.
- `agent-network`, because it requires the remote Pi tool set.
- `pi-subagents`, because it requires Pi's subagent tool.

The `github` skill remains compatible because Den provides its controlled RepoWolf `gh` command.

## `pi-den` runtime tools

`pi-den` will add the helper commands that the current Pi setup installs:

- CodeGraph CLI.
- CodeGraph Viz.
- Notion CLI.

Den will place these commands inside its runtime closure. Fence and RepoWolf will continue to control their filesystem, command, and network access.

The bundle itself will not declare runtime commands. Consumers of `den-bundle` can select their own Den `extraPkgs` values.

## Managed Pi configuration

The following paths will be authoritative in the selected Den agent directory:

| Destination | Packaged source |
| --- | --- |
| `settings.json` | Den-specific generated settings |
| `AGENTS.md` | `pi-config/AGENTS.md` |
| `mcp.json` | `pi-config/mcp.json` |
| `claude-bridge.json` | `pi-config/claude-bridge.json` |
| `loadout.json` | `pi-config/loadout.json` |
| `loadout-profiles.json` | `pi-config/loadout-profiles.json` |
| `agents` | `pi-config/agents` |
| `profiles/pi-subagents/openai.json` | packaged OpenAI profile |
| `profiles/pi-subagents/kimi.json` | packaged Kimi profile |

The `agents` destination will be one immutable directory link. The two profile destinations will be separate file links.

Separate profile links let unrecognized profile files remain in the same mutable directory.

The two loadout files supply the packaged default loadout and presets. Upstream `pi-loadout` reads them only from `~/.pi/agent`, which Den never selects. This repository will patch `pi-loadout` to use Pi's `getAgentDir()`. That function returns `PI_CODING_AGENT_DIR` when it is set and `~/.pi/agent` otherwise, so the Home Manager installation keeps its current paths.

Because the loadout files are managed, `pi-loadout` treats them as Nix-managed and refuses to save a new default or preset over them.

The managed set will not contain either of these directories:

- `agent-teams`
- `multi-model-planning-teams`

The managed set will also omit extensions, skills, themes, and `node_modules`. Den will inject those immutable resources through the bundle.

Den will leave these examples mutable:

- `auth.json`
- session data
- caches
- trust decisions
- Context Mode data
- extra subagent profile files
- any unrecognized path

A user or Pi process can replace a managed leaf during a session. Den will restore the packaged link before the next launch.

## Den managed-state primitive

Den's `mkPi` interface will accept a state-file map for the agent binding. The intended shape is:

```nix
stateFiles.agent = {
  "settings.json" = denSettings;
  "AGENTS.md" = "${piConfig}/AGENTS.md";
  "mcp.json" = "${piConfig}/mcp.json";
  "claude-bridge.json" = "${piConfig}/claude-bridge.json";
  "loadout.json" = "${piConfig}/loadout.json";
  "loadout-profiles.json" = "${piConfig}/loadout-profiles.json";
  "agents" = "${piConfig}/agents";
  "profiles/pi-subagents/openai.json" = "${piConfig}/profiles/pi-subagents/openai.json";
  "profiles/pi-subagents/kimi.json" = "${piConfig}/profiles/pi-subagents/kimi.json";
};
```

The exact internal representation can differ. The public behavior must match this contract.

Each source must resolve to a Nix store path. Each destination must be a normalized relative path without `.` or `..` components.

Den will create missing parent directories with private permissions. Existing parent directories must be real directories owned by the runtime user.

Den will reject a parent symlink. It will also reject a real directory at a managed leaf because replacing that directory can erase user data.

For a valid file or symlink leaf, Den will create a temporary symlink and rename it over the leaf. This operation makes each replacement atomic.

Den will anchor path operations to the validated state directory. It must not follow a changed path outside that directory.

## Launch sequence

`pi-den` will use this sequence:

1. Den selects the agent and session directories.
2. Den validates and opens both directories.
3. Den validates all managed sources and destinations.
4. Den creates required parent directories.
5. Den atomically restores every managed leaf.
6. Den validates the state directories again.
7. Den starts Fence with all resource closures available.
8. Fence starts Pi with the selected state and bundle resources.

The managed-state operation must occur before Pi reads `settings.json` or `AGENTS.md`.

An outer `pi-den` seeding script is not acceptable. Such a script would write before Den validates and anchors the selected directory.

## Settings construction

The implementation will derive the Den settings from the same settings library as `pi-config`. It will use the repository defaults, selected theme, provider, model, and extension settings.

The implementation will remove the `packages` key from the final Den settings object. It will not maintain a separate handwritten settings file.

This arrangement keeps shared settings in one source while preventing duplicate package loading.

## Error handling

Nix evaluation will fail for a malformed bundle resource or a non-store resource.

A `pi-den` launch will fail before Pi starts in these cases:

- A selected state directory fails Den validation.
- A managed destination is absolute or contains an unsafe component.
- A managed source is absent or outside the Nix store.
- A managed parent is a symlink or has an unsafe owner or mode.
- A real directory occupies a managed leaf.
- A link replacement fails.
- The final state-directory validation fails.

The error will name the managed destination and the failed condition. It will not print credentials or other mutable state.

Successful replacements can remain after a later replacement fails. Pi will not start, and the next launch will restore the complete set.

## Security properties

The design keeps one security boundary. Den validates state, prepares managed links, and starts Fence.

The packaged sources are immutable Nix store paths. The writable agent directory contains links to those sources, not writable copies.

The resource and managed-state closures will be readable inside Fence. Den will not grant access to unrelated host configuration or credential paths.

The package will use Den's Pi and its hardening patches. This repository will not substitute its existing Pi derivation into `mkPi`.

## Testing and verification

The Testing Value Gate excludes tests that only assert Nix source text or static JSON content. Package builds and runtime behavior will provide the useful evidence.

The implementation will add checks for these behaviors:

1. Both `pi` and `claude` bundle resources pass Den's resource validation.
2. `pi-den` builds and exposes `bin/pi-den`, without a `bin/pi` collision.
3. A fresh agent directory receives every managed path.
4. A changed managed file is restored on the next launch.
5. Mutable authentication and extra profile files remain unchanged.
6. An unsafe parent symlink stops the launch before Pi starts.
7. Pi loads the packaged extensions through a Home Manager-like runtime path.
8. Claude can start the packaged Context Mode MCP server with writable state.
9. `pi-loadout` reads and writes its files in `PI_CODING_AGENT_DIR` when that variable is set.
10. The packaged default loadout applies inside `pi-den`.

The final verification will include:

```sh
nix build .#packages.x86_64-linux.den-bundle --no-link
nix build .#packages.x86_64-linux.pi-den --no-link
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
```

If the implementation adds a dedicated `pi-den` runtime check, the final verification must run that check directly too.

A manual smoke test will launch `pi-den` with a temporary agent directory. The test will inspect the managed links, mutate one, relaunch, and inspect it again.

## Risks and controls

### Den interface drift

The Den update can change the constructor or bundle schema. Implementation will use the pinned revision and its machine-checked fixture as the source of truth.

### Duplicate Pi resources

A `packages` key in the managed settings can load each package twice. The Den settings generator will omit that key.

### Mutable-state loss

Replacing a real directory can erase user data. Den will reject real directories at managed leaves instead of removing them.

### Stale managed links

A Pi process can replace a link after launch. The next launch restores the packaged link, which is the required authority boundary.

### Resource compatibility

A skill can assume a command that Den does not provide. The Claude list is explicit and excludes skills with unmet runtime dependencies.

### Version divergence

Den and this repository can package different Pi behavior later. The pinned Den input and runtime checks make that divergence visible during updates.

## Rejected alternatives

### Outer seeding wrapper

This wrapper would prepare files before Den validates the selected state path. It would duplicate security-sensitive path handling, so this design rejects it.

### Home Manager deployment

Home Manager links would work for one host configuration. They would make `pi-den` non-standalone and would not cover direct flake consumers.

### Mutable first-launch copies

First-launch copies would let packaged settings drift. The user requires the package to restore its configuration on every launch.

### One profile-directory link

A directory link would block extra user profiles. Separate profile links preserve unrecognized files while keeping the two packaged profiles authoritative.
