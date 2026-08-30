# pi-claude-bridge NixOS Binary Design

## Context

`pi-claude-bridge` 0.7.0 depends on `@anthropic-ai/claude-agent-sdk` 0.2.141. On x86-64 Linux, the SDK starts its bundled `claude` executable from `@anthropic-ai/claude-agent-sdk-linux-x64`.

The published executable expects the generic glibc loader at `/lib64/ld-linux-x86-64.so.2`. NixOS does not provide that path. The child process therefore exits with status 127. The SDK then writes its initialization request to the closed subprocess and reports the secondary `EPIPE: broken pipe, send` error.

## Decision

Patch the bundled SDK executable as part of the existing `piClaudeBridge` Nix derivation.

Add `pkgs.autoPatchelfHook` to the derivation's native build inputs and `pkgs.stdenv.cc.cc.lib` to its runtime build inputs. During fixup, Nix will replace the generic ELF loader and runtime-library references with Nix store paths.

Keep the bundled executable rather than setting `provider.pathToClaudeCodeExecutable`. This keeps the bridge coupled to the Claude Code version selected by its Agent SDK and does not add a second package-version relationship.

## Alternatives

1. **Use `llm-agents` Claude Code:** The jailed Pi environment already contains `inputs.llm-agents.packages.${system}.claude-code`. Pointing the bridge at it avoids the broken bundled executable, but currently pairs Agent SDK 0.2.141 with a different Claude Code version. It also requires threading that package's executable path through every supported Pi launch configuration.
2. **Enable `nix-ld`:** This can make generic Linux binaries run on one NixOS machine, but it moves the fix outside the package and does not protect other users or build environments.

## Regression check

Use a build-time check in the `piClaudeBridge` derivation. After fixup, run the packaged bundled executable with `--version` and require a successful exit. The expected output identifies Claude Code 2.1.141.

Develop this check with a red-green cycle:

1. Add the version check before adding the patch inputs and confirm that the derivation fails because the executable cannot start.
2. Add the auto-patching inputs and confirm that the same derivation succeeds.

This check proves runtime behavior that can regress when the bridge or Agent SDK dependency changes. It does not merely assert a package version or Nix expression value.

## Verification

After the derivation passes its build-time check:

1. Build the packaged Pi configuration and locate the bundled SDK executable in the resulting bridge package.
2. Run that executable with `--version` on NixOS.
3. Run `pi-config-extension-load` to verify that Pi still loads the packaged extension.
4. Run `jailed-pi-auth-mode` because the jailed environment includes Claude-related runtime setup.
5. Reproduce a Pi request through the Claude bridge provider with SDK debug logging. Confirm that the child process no longer exits with status 127 and that the request does not fail with the derived `EPIPE` error.
6. Run the full flake check required for Pi package and dependency changes.

## Scope

The implementation changes only `nix/packages/pi-deps.nix`. It does not change `claude-bridge.json`, replace the SDK executable, update package pins, enable `nix-ld`, or modify upstream bridge source.

## Acceptance criteria

- The `piClaudeBridge` derivation patches its bundled x86-64 Linux Claude executable.
- The derivation fails if the packaged executable cannot run `--version` after fixup.
- The packaged executable reports Claude Code 2.1.141 on NixOS.
- Existing Pi extension-load and jailed-auth checks pass.
- A real Pi Claude-provider request no longer reports subprocess exit 127 or the resulting `EPIPE` error.
- The full flake check passes.
