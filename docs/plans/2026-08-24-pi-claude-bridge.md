# pi-claude-bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install `pi-claude-bridge` 0.7.0 in the Nix-managed Pi package and enable its optional `AskClaude` tool.

**Architecture:** Nix fetches the published npm tarball and builds its runtime dependency graph in the store. Generated Pi settings load that immutable package path. One `claude-bridge.json` file enables `AskClaude`, and each supported Pi launch path links that file into its active configuration directory.

**Tech Stack:** Nix flakes, `pkgs.buildNpmPackage`, npm package locks, Home Manager, shell-based Nix checks, JSON.

## Global Constraints

- Pin `pi-claude-bridge` to version 0.7.0.
- Set only `askClaude.enabled` to `true`.
- Keep all other bridge settings at their upstream defaults.
- Do not change the default Pi provider or model.
- Do not set a Claude plan, long-context option, or Claude executable path.
- Do not modify the upstream extension source.
- Do not send a real Claude request during verification.
- Support the Home Manager, project, and jailed Pi launch paths.
- Detect missing modules and extension-load errors with the existing runtime check.

---

### Task 1: Package the Claude bridge and add it to generated Pi settings

**Files:**
- Create: `nix/packages/pi-claude-bridge-package-lock.json`
- Modify: `nix/packages/pi-deps.nix:36-108,214-237`

**Interfaces:**
- Consumes: The npm tarball at `https://registry.npmjs.org/pi-claude-bridge/-/pi-claude-bridge-0.7.0.tgz`.
- Produces: `piDeps.piClaudeBridge` and the package path `${piClaudeBridge}/lib/node_modules/pi-claude-bridge` in generated Pi settings.

This task is a dependency pin and package configuration change. The Testing Value Gate excludes a new automated test for the exact version or lock contents. Use build and runtime-load verification instead.

- [ ] **Step 1: Generate the production package lock**

Run this command from the repository root:

```bash
set -euo pipefail
url='https://registry.npmjs.org/pi-claude-bridge/-/pi-claude-bridge-0.7.0.tgz'
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
source_path="$(nix store prefetch-file --unpack --json "$url" | jq -r .storePath)"
cp "$source_path/package.json" "$tmp/package.json"
(
  cd "$tmp"
  npm install --package-lock-only --ignore-scripts --omit=dev --omit=peer
)
LOCK_PATH="$tmp/package-lock.json" python3 - <<'PY'
import json
import os

lock_path = os.environ["LOCK_PATH"]
with open(lock_path, encoding="utf-8") as handle:
    lock = json.load(handle)

integrities = {
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core": "sha512-RorGp9OH5l3ElpuC5a5ZQ2eWcchZGXflXRzVGkV99y3y6tT+LLNyxoYIdVKvTKWEObwhExeQbTH0fI2tE4iX4g==",
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai": "sha512-m3IZD4g3er0V8TC9+Vpgw/sjTKqcJlkcIBy/JvsgRubuuik3tAVzyugUg4rVrShIkkOT69mEd34NEqKUIsl6JQ==",
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui": "sha512-IoYrb0rORjELmEpNtoCA/U8je3KopMkRAVJRdSzvXRvgb+Huo1gNh8Q5CSZvNOiYtDxJdj2tYZZHZ4B3+IN3hA==",
}
for path, integrity in integrities.items():
    entry = lock["packages"][path]
    assert entry["version"] == "0.83.0", (path, entry["version"])
    entry["integrity"] = integrity

with open(lock_path, "w", encoding="utf-8") as handle:
    json.dump(lock, handle, indent=2)
    handle.write("\n")
PY
cp "$tmp/package-lock.json" nix/packages/pi-claude-bridge-package-lock.json
```

npm omits integrity fields from three nested Pi development packages. The inline script restores their npm registry integrity values so Nix can prefetch the lock.

Make sure that the lock names version 0.7.0 and has no registry entry without integrity:

```bash
jq -e '.name == "pi-claude-bridge" and .version == "0.7.0"' \
  nix/packages/pi-claude-bridge-package-lock.json
python3 - <<'PY'
import json

with open("nix/packages/pi-claude-bridge-package-lock.json", encoding="utf-8") as handle:
    lock = json.load(handle)
missing = [
    path
    for path, entry in lock["packages"].items()
    if path
    and entry.get("resolved", "").startswith("https://registry.npmjs.org/")
    and "integrity" not in entry
]
assert not missing, missing
PY
```

Expected: both commands exit with status 0.

- [ ] **Step 2: Add the Nix derivation**

Add this block near the existing npm tarball packages in `nix/packages/pi-deps.nix`:

```nix
    piClaudeBridgePackageLock = ./pi-claude-bridge-package-lock.json;

    piClaudeBridgeSrc = pkgs.fetchzip {
      url = "https://registry.npmjs.org/pi-claude-bridge/-/pi-claude-bridge-0.7.0.tgz";
      hash = "sha256-M3eNmab9AZJWVkPFYXrVLDMEmXIqsGnQM9KRbffq+dk=";
    };

    piClaudeBridge = pkgs.buildNpmPackage {
      pname = "pi-claude-bridge";
      version = "0.7.0";
      src = piClaudeBridgeSrc;

      npmDepsHash = "sha256-F9gvUefKU10yaCDVaCjdB/e5tCUybpNs1koZ2HSrURE=";

      dontNpmBuild = true;
      makeCacheWritable = true;
      npmInstallFlags = [
        "--omit=dev"
        "--omit=peer"
      ];

      postPatch = ''
        cp ${piClaudeBridgePackageLock} package-lock.json
      '';
    };
```

Add `piClaudeBridge` to the returned `inherit` list. Add its package directory to `packagePaths`:

```nix
      "${piClaudeBridge}/lib/node_modules/pi-claude-bridge"
```

- [ ] **Step 3: Build and inspect the packaged extension**

Git-backed flakes omit untracked files. Stage the lock before the build, then inspect the result:

```bash
git add nix/packages/pi-claude-bridge-package-lock.json
out="$(nix build .#packages.x86_64-linux.pi-config --no-link --print-out-paths)"
bridge_path="$(jq -r '.packages[] | select(endswith("/lib/node_modules/pi-claude-bridge"))' "$out/settings.json")"
test -n "$bridge_path"
test -f "$bridge_path/src/index.ts"
test -d "$bridge_path/node_modules/@anthropic-ai/claude-agent-sdk"
```

Expected: every command exits with status 0. The selected path ends with `/lib/node_modules/pi-claude-bridge`.

- [ ] **Step 4: Run the runtime extension-load check**

Run:

```bash
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Expected: exit status 0. The logs contain no `Failed to load extension`, `No such built-in module`, or `Cannot find package` error.

- [ ] **Step 5: Commit the package integration**

Review and commit only the package files:

```bash
git diff --check
git diff -- nix/packages/pi-deps.nix
git diff --cached -- nix/packages/pi-claude-bridge-package-lock.json
git add nix/packages/pi-deps.nix nix/packages/pi-claude-bridge-package-lock.json
git commit -m "feat(pi): package Claude bridge extension"
```

---

### Task 2: Enable AskClaude and propagate the bridge configuration

**Files:**
- Create: `claude-bridge.json`
- Modify: `modules/packages/pi-config.nix:80-108`
- Modify: `nix/lib/pi-resources.nix:68-104`
- Modify: `modules/home/pi.nix:81-97`
- Modify: `modules/home/jailed-pi.nix:245-263`
- Modify: `modules/lib/project-pi.nix:43-64`
- Modify: `modules/checks/jailed-pi-auth-mode.nix:193-244`
- Modify: `modules/checks/pi-config-extension-load.nix:25-52`

**Interfaces:**
- Consumes: The generated `pi-config` package and the package path from Task 1.
- Produces: An immutable `claude-bridge.json` file in normal, project, and jailed Pi configuration directories.

The resource-link check proves launch-path behavior and can catch meaningful regressions. The exact JSON value is static configuration, so verify it directly instead of adding an automated content assertion.

- [ ] **Step 1: Add failing resource-link coverage**

In `modules/checks/jailed-pi-auth-mode.nix`, add `claude-bridge.json` to `assert_resource_links()`:

```bash
            for resource in \
              AGENTS.md \
              claude-bridge.json \
              mcp.json \
```

At the start of `assert_runtime_resources_and_sessions()`, after its three local assignments, add this project-resource assertion:

```bash
            assert_link_target \
              "$test_repo/.pi/claude-bridge.json" \
              "${self'.packages.pi-config}/claude-bridge.json"
```

Run:

```bash
nix build .#checks.x86_64-linux.jailed-pi-auth-mode --no-link
```

Expected: FAIL because the project and jailed agent directories do not contain the new link.

- [ ] **Step 2: Create the minimal bridge configuration**

Create `claude-bridge.json` with this exact content:

```json
{
  "askClaude": {
    "enabled": true
  }
}
```

Do not add provider settings or other `AskClaude` overrides.

- [ ] **Step 3: Add the configuration to the Pi package and resource package**

In `modules/packages/pi-config.nix`, copy the source file beside `settings.json` and `mcp.json`:

```nix
        cp ${../../claude-bridge.json} "$out/claude-bridge.json"
```

In `nix/lib/pi-resources.nix`, define the package path:

```nix
  claudeBridgeJson = "${package}/claude-bridge.json";
```

Add it to `resourcesPackage`:

```nix
    ln -s ${claudeBridgeJson} "$out/claude-bridge.json"
```

Export `claudeBridgeJson` in the final `inherit` list.

- [ ] **Step 4: Link the configuration into every launch path**

Add this Home Manager entry in `modules/home/pi.nix`:

```nix
          ".pi/agent/claude-bridge.json" = {
            force = true;
            source = piResources.claudeBridgeJson;
          };
```

Add this activation link in `modules/home/jailed-pi.nix`:

```nix
          ln -sfnT ${piResources.package}/claude-bridge.json "$agent_dir/claude-bridge.json"
```

Add this project link in `modules/lib/project-pi.nix` before writing `.pi/settings.json`:

```nix
          ln -sfnT ${piConfigPackage}/claude-bridge.json .pi/claude-bridge.json
```

Add this jailed-agent link in the same file:

```nix
            ln -sfnT ${piConfigPackage}/claude-bridge.json "$agent_dir/claude-bridge.json"
```

- [ ] **Step 5: Load the configuration in the runtime extension fixture**

In `modules/checks/pi-config-extension-load.nix`, add this link beside the settings and MCP links:

```nix
            ln -s ${piConfig}/claude-bridge.json "$agent_dir/claude-bridge.json"
```

This fixture starts Pi without sending a provider request. It tests extension initialization and bridge configuration parsing.

- [ ] **Step 6: Stage the new file and run targeted verification**

Git-backed flakes omit untracked files. Stage the configuration before the build:

```bash
git add claude-bridge.json
nix build .#checks.x86_64-linux.jailed-pi-auth-mode --no-link
out="$(nix build .#packages.x86_64-linux.pi-config --no-link --print-out-paths)"
jq -e '. == {"askClaude":{"enabled":true}}' "$out/claude-bridge.json"
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Expected: both Nix checks exit with status 0. The `jq` command prints `true` and exits with status 0.

- [ ] **Step 7: Run the full flake check**

Run:

```bash
nix flake check --accept-flake-config --print-build-logs
```

Expected: exit status 0 with no failed flake check.

- [ ] **Step 8: Review and commit the configuration integration**

Run:

```bash
git status --short
git diff --check
git diff --stat
git diff HEAD -- claude-bridge.json \
  modules/packages/pi-config.nix \
  nix/lib/pi-resources.nix \
  modules/home/pi.nix \
  modules/home/jailed-pi.nix \
  modules/lib/project-pi.nix \
  modules/checks/jailed-pi-auth-mode.nix \
  modules/checks/pi-config-extension-load.nix
git add claude-bridge.json \
  modules/packages/pi-config.nix \
  nix/lib/pi-resources.nix \
  modules/home/pi.nix \
  modules/home/jailed-pi.nix \
  modules/lib/project-pi.nix \
  modules/checks/jailed-pi-auth-mode.nix \
  modules/checks/pi-config-extension-load.nix
git commit -m "feat(pi): enable AskClaude bridge"
```

Expected: the commit contains only the listed package, resource, module, and check changes.

---

### Task 3: Resolve final review findings

**Files:**
- Modify: `claude-bridge.json`
- Modify: `nix/check-support/pi-skillset-probe.ts`
- Modify: `modules/checks/pi-config-extension-load.nix`
- Modify: `docs/specs/2026-08-24-pi-claude-bridge-design.md`
- Modify: `docs/plans/2026-08-24-pi-claude-bridge.md`

Final review found that version 0.7.0 writes `startupNoticeShown` before the first TUI bridge-provider query when `provider.plan` is absent. The managed file is immutable, so this write fails with `EROFS`. The user approved an explicit Pro plan. This decision supersedes the earlier constraints that prohibited a plan value and allowed only `askClaude.enabled`. The Pro value matches the upstream effective default.

The review also found that the runtime check did not observe `AskClaude` registration. This behavior check can catch a meaningful regression, so it passes the Testing Value Gate.

- [ ] **Step 1: Add a tool-set behavior probe**

Extend `nix/check-support/pi-skillset-probe.ts` with an extension command that writes the registered and active tool names. Guard the probe with `before_provider_request` so an unexpected agent path cannot send a provider request.

Run the command from `pi-config-extension-load` with `--no-builtin-tools`. Require `AskClaude` in both tool sets.

Prove the check with a red-green cycle:

1. Temporarily set `askClaude.enabled` to `false`.
2. Run `nix build .#checks.x86_64-linux.pi-config-extension-load --no-link` and require an `AskClaude` assertion failure.
3. Restore `askClaude.enabled` to `true`.
4. Run the same check and require exit status 0.

- [ ] **Step 2: Keep the effective Pro default explicit**

Set this exact configuration:

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

Do not add Max-plan, long-context, executable-path, or other `AskClaude` settings.

- [ ] **Step 3: Run targeted verification**

Run:

```bash
out="$(nix build .#packages.x86_64-linux.pi-config --no-link --print-out-paths)"
jq -e '. == {"askClaude":{"enabled":true},"provider":{"plan":"pro"}}' \
  "$out/claude-bridge.json"
nix build .#checks.x86_64-linux.jailed-pi-auth-mode --no-link
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Expected: the JSON check prints `true`. Both Nix checks exit with status 0. The runtime check observes `AskClaude` without a provider request.

- [ ] **Step 4: Run the full flake check**

Run:

```bash
nix flake check --accept-flake-config --print-build-logs
```

Expected: exit status 0 with no failed flake check.

- [ ] **Step 5: Review and commit the follow-up**

Review the complete diff from `89f8aec` through `HEAD`. Commit the five Task 3 files with a focused Conventional Commits subject. Do not push.
