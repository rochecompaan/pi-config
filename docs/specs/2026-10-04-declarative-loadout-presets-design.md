# Declarative loadout presets

## Approved scope

This document records the design approved in session `01a1008e-f264-7456-9f81-40fbf1a42a01`.
The user approved the preset contents, shared resources, and Nix ownership before implementation.

Nix generates two named presets:

- `superpowers` contains all Superpowers skills. It also contains `codebase-design`, `improve-codebase-architecture`, `domain-modeling`, and `wait-what` from Matt.
- `matt` contains all packaged Matt engineering and productivity skills. It excludes Superpowers skills.

Both presets contain all shared skills and tools.
The default preset is `superpowers`.
Home Manager installs the generated preset files and the default selection.
The `/loadout use` command selects a named preset in the current session.
Preset edits belong in the Nix configuration, not the generated store files.
Home Manager replaces existing regular files at both loadout paths.
The picker and command help hide write actions for Nix-managed files.
Save and delete attempts show a notification instead of a file permission error.
Writable, user-managed files retain the original save and delete behavior.

### First activation

Before the first activation, copy existing loadout files to a backup location:

- `~/.pi/agent/loadout.json`
- `~/.pi/agent/loadout-profiles.json`

The first activation replaces these files with the declarative selection and presets.

## Resource catalog

The catalog uses the resources loaded by the packaged Pi process.
Package paths identify each skill suite.
The catalog also records skills that require manual invocation.
Those skills remain selectable but do not appear in the automatic skill list.

Some extensions register tools immediately before the first model request.
The catalog probe reaches that stage with a local provider.
The provider records the available tools and stops without a remote model request.

## Generated files

- `loadout-catalog.json` records tools, skills, suite membership, and manual skills.
- `loadout-profiles.json` records both named selections and the default profile name.
- `loadout.json` records the actual default tool and skill selection.

The Home Manager option `programs.roche-pi.loadout` accepts overrides for the preset definition and default profile.
Unknown suites, extra skills, or default profile names produce an error before the renderer writes the selection files.
An empty tool catalog also produces an error.

## Startup behavior

The saved selection retains names that are not yet available during `session_start`.
Pi restores the selected tools after its startup setup.
A later prompt activates selected tools that finish registration after the first request.
This later reconciliation preserves tools activated through discovery.
An explicit loadout change cancels the old pending selection.
The new selection retains its own late-loaded names, even before MCP connects.
Built-in presets expand against the available catalog.

CLI tool restrictions still apply.
The `--no-skills` option disables configured discovery. Extension-injected skills remain subject to the selected loadout.
The Superpowers reminder appears only with its selected bootstrap skill.

## Verification

Renderer tests cover suite separation, shared resources, default selection, and invalid inputs.
Runtime tests cover automatic startup, explicit switching, restricted selections, CLI options, and the built-in full preset.
The extension-load check and full flake check remain required.
Documentation needs no new automated test. Direct review verifies this document against the approved requirements.

## Delivery boundary

This change does not publish packages or activate the live Home Manager configuration.
Main contains newer changes. Integration must preserve those changes and repeat the affected verification.
