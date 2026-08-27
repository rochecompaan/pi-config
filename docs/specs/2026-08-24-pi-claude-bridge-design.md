# pi-claude-bridge Design

## Context

The Pi configuration does not include `pi-claude-bridge`. The package adds a Claude Code provider and an optional `AskClaude` tool.

The published npm package is `pi-claude-bridge` version 0.7.0. It has runtime dependencies, so a fetched source directory is not sufficient. The Nix configuration must install these dependencies before Pi loads the extension.

## Goals

- Install `pi-claude-bridge` version 0.7.0 in the Nix-managed Pi configuration.
- Enable the optional `AskClaude` tool.
- Set `provider.plan` to `pro`, which is the upstream effective default.
- Keep all other bridge settings at their upstream defaults.
- Support the Home Manager, project, and jailed Pi launch paths.
- Detect extension-load errors before release.

## Non-goals

- Do not change the default Pi provider or model.
- Do not configure the Max plan or long-context billing behavior.
- Do not override the Claude Code executable path.
- Do not invoke Claude Code during the Nix checks.
- Do not modify the upstream extension source.

## Package source

Nix will fetch the published npm tarball for version 0.7.0. The source hash will pin the published package bytes.

A repository-owned package lock will describe the production dependency graph. `pkgs.buildNpmPackage` will install this graph in the Nix store. The derivation will omit development dependencies and will not run an upstream build step.

The generated Pi settings will include this package path:

```text
${piClaudeBridge}/lib/node_modules/pi-claude-bridge
```

This method matches the existing Nix-managed npm package pattern in `nix/packages/pi-deps.nix`. It does not require network access when Pi starts.

## Bridge configuration

The Pi configuration package will contain `claude-bridge.json` with this data:

```json
{
  "askClaude": {
    "enabled": true
  },
  "provider": {
    "plan": "pro"
  }
}
```

The explicit Pro plan matches the upstream effective default. It prevents version 0.7.0 from writing a startup notice marker to the immutable file. The extension will use its defaults for all other provider and `AskClaude` options.

## Resource propagation

The Home Manager module will link `claude-bridge.json` to `~/.pi/agent/claude-bridge.json`.

The shared resource package will expose the same file. The jailed Pi activation and project shell hook will link it into their active agent or project configuration directories.

All launch paths will read one immutable file from the Nix store. This prevents differences between normal, project, and jailed Pi sessions.

## Error handling

Nix evaluation will fail if the package source or dependency hash changes. The package build will fail if npm cannot reproduce the pinned dependency graph.

The runtime extension-load check will fail if Pi cannot import `pi-claude-bridge` or its runtime dependencies. The check will also require `AskClaude` in the registered and active tool sets. The check will not require Claude authentication because an extension command collects the tool sets before agent processing.

## Verification

This change affects a package pin and static configuration. A new test of JSON text or dependency versions does not prove useful behavior.

Verification will use these commands:

```sh
nix build .#packages.x86_64-linux.pi-config --no-link
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
```

The runtime check must load the extension without `Failed to load extension`, missing-module, or missing-package errors. It must also show that `AskClaude` is registered and active.

## Security

Pi extensions execute with the permissions of the Pi process. `pi-claude-bridge` can start Claude Code and can expose Pi tools to that process.

The configuration keeps the upstream `AskClaude` defaults. Read mode remains the default mode. Full mode remains available because that is the upstream default. The explicit Pro plan keeps the upstream effective provider behavior.
