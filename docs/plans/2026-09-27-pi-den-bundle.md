# Pi Den Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a reusable `den-bundle` and a standalone `pi-den` command that inject this repository's immutable configuration while Den keeps credentials, sessions, caches, and other unlisted state mutable.

**Architecture:** Keep `pi-config` as the authoritative Pi package root, expose it and its external Pi packages through Den bundle metadata, and generate Den settings through the same Nix settings library without a `packages` key. Build `pi-den` with the pinned Den `mkPi`, use Den's `stateFiles.agent` primitive for authoritative links, and rename only the outer executable to avoid colliding with the existing `pi` package.

**Tech Stack:** Nix flakes, flake-parts/import-tree, Den `mkPi` and resource bundles, Pi 1.0.2, jq/Python runtime probes, Context Mode MCP JSON-RPC.

## Global Constraints

- Execute only after `docs/plans/2026-09-27-den-managed-state-files.md` is implemented, reviewed, and available from Den's `main` branch.
- Pin Den through `flake.lock`; do not use a mutable runtime Git URL or copy Den source into this repository.
- Publish `packages.x86_64-linux.den-bundle` and `packages.x86_64-linux.pi-den` without changing the existing default, `pi`, `pi-matt`, `pi-superpowers`, Home Manager, or development-shell outputs.
- `pi-den` must use Den's packaged Pi 1.0.2 and its preview/security patches. Do not pass this repository's Pi derivation into Den.
- `pi-den` must expose only `bin/pi-den`, forward all arguments unchanged, and preserve Den's exit status.
- The Pi bundle must use only the `packages` resource class: `pi-config`, `pi-context-paging`, Context Mode, `pi-claude-bridge`, `pi-codegraph`, `pi-listen`, `pi-loadout`, Matt Pocock skills, Superpowers, `pi-remote`, `pi-subagents`, `pi-vim`, and `remote-pi`.
- Pass bundle resources as packages or store-path strings. Do not wrap a store path in a symlink derivation.
- Do not add direct Pi extension, skill, prompt-template, or theme resources; `pi-config/package.json` remains authoritative.
- Den settings must be generated from the shared settings library and must not contain a `packages` key.
- Authoritative managed destinations are exactly: `settings.json`, `AGENTS.md`, `mcp.json`, `claude-bridge.json`, `loadout.json`, `loadout-profiles.json`, `agents`, `profiles/pi-subagents/openai.json`, and `profiles/pi-subagents/kimi.json`.
- `pi-loadout` must locate its files through Pi's `getAgentDir()`, so it follows `PI_CODING_AGENT_DIR` and still defaults to `~/.pi/agent`.
- `pi-den` does not support `PI_CODING_AGENT_AUTH_FILE`; Den's Pi does not carry that patch.
- Do not manage `extensions`, `skills`, `themes`, `node_modules`, `agent-teams`, or `multi-model-planning-teams` in the Den agent directory.
- Claude resources must contain the approved compatible skill set and the Context Mode MCP server only. Do not add Claude plugins or settings fragments.
- `pi-den` runtime tools are CodeGraph CLI, CodeGraph Viz, and Notion CLI. The reusable bundle must not force runtime tools on other consumers.
- Keep provider credentials, `auth.json`, sessions, caches, trust decisions, Context Mode data, unknown files, and extra subagent profiles mutable and outside Nix configuration.

---

## Execution Workspace

Use the existing task worktree and branch:

```bash
cd /home/roche/projects/pi/roche-pi/.worktrees/pi-den-managed-config
git branch --show-current
```

Expected branch: `feat/pi-den-managed-config`.

Before Task 2, confirm that the reviewed Den `main` contains Pi 1.0.2, `stateFiles.agent`, and store-path string resources (Den `69a9a20` or later). The `den` lock update must resolve to that reviewed commit.

## File Structure

| Path | Responsibility |
| --- | --- |
| `flake.nix` | Declare the Den input. |
| `flake.lock` | Pin the reviewed Den commit and its input graph. |
| `nix/lib/pi-settings.nix` | Generate shared Pi settings from repository defaults for normal and Den packages. |
| `modules/packages/pi-config.nix` | Consume the shared settings generator without changing the existing package contract. |
| `nix/packages/den-bundle.nix` | Define `passthru.denResources` for Pi and Claude. |
| `modules/packages/den-bundle.nix` | Wire dependencies and publish `packages.den-bundle`. |
| `patches/pi-loadout-agent-dir.patch` | Make `pi-loadout` read and write its files in Pi's agent directory. |
| `nix/packages/pi-deps.nix` | Apply the `pi-loadout` agent-directory patch. |
| `nix/check-support/loadout-runtime.test.py` | Prove `pi-loadout` follows `PI_CODING_AGENT_DIR`. |
| `nix/packages/pi-den.nix` | Generate Den settings, declare managed paths, instantiate Den `mkPi`, and expose only `pi-den`. |
| `modules/packages/pi-den.nix` | Supply flake inputs/packages and publish `packages.pi-den`. |
| `nix/check-support/den-bundle-claude.nix` | Validate bundle normalization, selected skills, MCP startup, and writable Claude state. |
| `nix/check-support/pi-den-runtime.nix` | Validate package shape, managed state, mutable siblings, and Pi resource loading. |
| `modules/checks/pi-den.nix` | Publish both focused checks. |
| `README.md` | Document direct use and bundle consumption; link the loadout files in the devenv example. |

### Task 1: Share Pi settings construction

**Files:**
- Create: `nix/lib/pi-settings.nix`
- Modify: `modules/packages/pi-config.nix:27-65`

**Interfaces:**
- Consumes: `piVersion`, optional `packagePaths`, optional `theme`, and optional `settingsOverrides`.
- Produces: the complete settings attribute set using `settings.json` and `nix/lib/settings.nix`.

- [x] **Step 1: Record a behavioral baseline**

Run the existing runtime extension-load check before refactoring:

```bash
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Expected: PASS. Save no generated artifacts in the repository.

- [x] **Step 2: Create the shared settings generator**

Create `nix/lib/pi-settings.nix`:

```nix
{ lib }:
{
  piVersion,
  packagePaths ? [ ],
  theme ? "stylix",
  settingsOverrides ? { },
}:
let
  settingsLib = import ./settings.nix { inherit lib; };
  baseSettings = builtins.fromJSON (builtins.readFile ../../settings.json);
in
settingsLib.mkSettings {
  inherit baseSettings packagePaths theme;
  settingsOverrides = lib.recursiveUpdate {
    lastChangelogVersion = piVersion;
  } settingsOverrides;
}
```

This file owns one responsibility: building the settings value. It must not write a derivation, know about Den, or choose resource packages.

- [x] **Step 3: Refactor `pi-config` to use the generator**

Replace the local `settingsLib`, `baseSettings`, and `settings` construction in `modules/packages/pi-config.nix` with:

```nix
piSettings = import ../../nix/lib/pi-settings.nix {
  inherit (pkgs) lib;
};

settings = piSettings {
  piVersion = piPackage.version;
  inherit (piDeps) packagePaths;
};
```

Keep `settingsJson`, theme generation, package assembly, and output names unchanged.

- [x] **Step 4: Verify the refactor directly**

The Testing Value Gate excludes a new test that would only assert static JSON construction. Use the existing build and runtime checks instead:

```bash
git add nix/lib/pi-settings.nix modules/packages/pi-config.nix
nix build .#packages.x86_64-linux.pi-config --no-link
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Expected: PASS.

- [x] **Step 5: Commit the shared settings seam**

```bash
git commit -m "refactor(nix): share Pi settings construction"
```

### Task 2: Publish and validate the reusable Den bundle

**Files:**
- Modify: `flake.nix:4-15`
- Modify: `flake.lock`
- Create: `nix/packages/den-bundle.nix`
- Create: `modules/packages/den-bundle.nix`
- Create: `nix/check-support/den-bundle-claude.nix`
- Create: `modules/checks/pi-den.nix`

**Interfaces:**
- Consumes: `pi-config`, `piDeps.packagePaths`, Superpowers skills, Context Mode skills and executable.
- Produces: `packages.den-bundle` with `passthru.denResources.pi` and `.claude`.

- [x] **Step 1: Pin the reviewed Den input**

Add to `flake.nix`:

```nix
den.url = "github:rochecompaan/den";
```

Do not set `den.inputs.nixpkgs.follows`; Den's reviewed package graph and security pins must remain intact.

Update only the new input:

```bash
nix flake lock --update-input den
nix flake metadata --json \
  | jq -e '.locks.nodes.den.locked.type == "github" and .locks.nodes.den.locked.rev != null'
```

Confirm the locked `rev` equals the reviewed Den `main` commit from the prerequisite plan.

- [x] **Step 2: Add the failing bundle check**

Create `modules/checks/pi-den.nix` with the Claude check only at first:

```nix
{ inputs, ... }:
{
  perSystem = { pkgs, self', system, ... }:
    let
      claude = inputs.den.lib.${system}.mkClaude {
        bundles = [ self'.packages.den-bundle ];
      };
    in {
      checks.den-bundle-claude = import ../../nix/check-support/den-bundle-claude.nix {
        inherit pkgs claude;
        bundle = self'.packages.den-bundle;
      };
    };
}
```

Create `nix/check-support/den-bundle-claude.nix` with a derivation that requires:

- `bundle.denResources.pi.packages` to exist.
- `bundle.denResources.claude.skills` and `.mcpServers.context-mode` to exist.
- `claude.resourceDiagnostics` to build.
- The generated Den skills plugin to contain `commit`, `frontend-design`, `github`, `module-size`, `nix-config`, `codebase-design`, `domain-modeling`, `simple-english`, `using-superpowers`, `test-driven-development`, `writing-plans`, `ctx-search`, and `context-mode`.
- The plugin not to contain `gitea`, `linear`, `notion`, `show-me`, `subagent-model-profiles`, `intervals-time-entries`, `agent-network`, or `pi-subagents`.
- The generated MCP config to point at the same immutable Context Mode command declared by the bundle.

Use a Python helper inside the derivation to locate `--plugin-dir` and `--mcp-config` pairs in `claude.denManifest.agent.resourceArgs`. Do not assert Nix source text.

Then initialize the Context Mode MCP server with a clean environment:

```bash
mkdir -m 0700 -p "$TMPDIR/home" "$TMPDIR/claude"
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"den-bundle-check","version":"1"}}}' \
  | env -i HOME="$TMPDIR/home" CLAUDE_CONFIG_DIR="$TMPDIR/claude" \
      "$contextModeCommand" > "$TMPDIR/context-mode.out"
grep -Fq '"id":1' "$TMPDIR/context-mode.out"
test -d "$TMPDIR/claude/context-mode/sessions"
test ! -e "$TMPDIR/home/.pi/context-mode"
```

- [x] **Step 3: Stage the new check and confirm RED**

```bash
git add flake.nix flake.lock modules/checks/pi-den.nix nix/check-support/den-bundle-claude.nix
nix build .#checks.x86_64-linux.den-bundle-claude --no-link
```

Expected: FAIL because `packages.den-bundle` does not exist.

- [x] **Step 4: Implement the bundle derivation**

Create `nix/packages/den-bundle.nix`:

```nix
{ pkgs, piConfig, piDeps }:
let
  selectedPiConfigSkills = map
    (name: "${piConfig}/skills/${name}")
    [
      "commit"
      "frontend-design"
      "github"
      "module-size"
      "nix-config"
      "simple-english"
    ];

  selectedMattPocockSkills = map
    (name: "${piDeps.mattPocockSkills}/skills/engineering/${name}")
    [
      "codebase-design"
      "domain-modeling"
    ];

  claudeSkills = selectedPiConfigSkills ++ selectedMattPocockSkills ++ [
    "${piDeps.superpowersSrc}/skills"
    "${piDeps.contextMode}/lib/node_modules/context-mode/skills"
  ];
in
pkgs.runCommand "roche-pi-den-bundle"
  {
    passthru.denResources = {
      pi.packages = [ piConfig ] ++ piDeps.packagePaths;
      claude = {
        skills = claudeSkills;
        mcpServers.context-mode = {
          command = "${piDeps.contextMode}/bin/context-mode";
          args = [ ];
        };
      };
    };
  }
  ''
    mkdir -p "$out"
  ''
```

This deliberately omits Pi direct resource classes and Claude `plugins`/`settings`.

- [x] **Step 5: Wire the public package**

Create `modules/packages/den-bundle.nix`:

```nix
{ ... }:
{
  perSystem = { pkgs, self', ... }:
    let
      piDeps = import ../../nix/packages/pi-deps.nix {
        inherit pkgs;
        piRemote = self'.packages.pi-remote;
      };
    in {
      packages.den-bundle = import ../../nix/packages/den-bundle.nix {
        inherit pkgs piDeps;
        piConfig = self'.packages.pi-config;
      };
    };
}
```

The existing `piDeps.packagePaths` order already matches the approved external Pi package order. Do not create a second list.

- [x] **Step 6: Run bundle validation**

```bash
git add nix/packages/den-bundle.nix modules/packages/den-bundle.nix
nix build .#packages.x86_64-linux.den-bundle --no-link
nix build .#checks.x86_64-linux.den-bundle-claude --no-link
```

Expected: PASS. Building the Claude consumer proves Den accepts the Claude half of the bundle. The Pi consumer in Task 3 will prove the Pi half.

- [x] **Step 7: Commit the input and bundle**

```bash
git commit -m "feat(nix): publish Den resource bundle"
```

### Task 3: Publish `pi-den` with authoritative managed configuration

**Files:**
- Create: `patches/pi-loadout-agent-dir.patch`
- Modify: `nix/packages/pi-deps.nix`
- Modify: `nix/check-support/loadout-runtime.test.py`
- Modify: `README.md`
- Create: `nix/packages/pi-den.nix`
- Create: `modules/packages/pi-den.nix`
- Create: `nix/check-support/pi-den-runtime.nix`
- Modify: `modules/checks/pi-den.nix`

**Interfaces:**
- Consumes: `inputs.den.lib.${system}.mkPi`, `packages.den-bundle`, `packages.pi-config`, and three helper CLI packages.
- Produces: `packages.pi-den`, `bin/pi-den`, `passthru.denPackage`, and `passthru.denSettings`. `pi-loadout` reads and writes its files in Pi's agent directory.

- [ ] **Step 1: Add failing `pi-loadout` agent-directory tests**

Upstream `pi-loadout` hard-codes `~/.pi/agent`. Den selects another agent directory and exports it as `PI_CODING_AGENT_DIR`, so the packaged loadout would never apply inside `pi-den`.

In `nix/check-support/loadout-runtime.test.py`, move the agent-directory population out of `setUp` into a helper, and let `probe` accept extra environment variables. Add two tests that point `PI_CODING_AGENT_DIR` at a second populated directory while `~/.pi/agent` keeps the `superpowers` default:

1. A `matt` default in the custom directory's `loadout.json` applies.
2. `/loadout save local`, with a writable custom `loadout-profiles.json`, writes the preset there and leaves `~/.pi/agent/loadout-profiles.json` unchanged.

- [ ] **Step 2: Confirm RED**

```bash
git add nix/check-support/loadout-runtime.test.py
nix build .#checks.x86_64-linux.pi-loadout-runtime --no-link
```

Expected: FAIL in both new tests, because `pi-loadout` still reads and writes `~/.pi/agent`.

- [ ] **Step 3: Patch `pi-loadout` to use Pi's agent directory**

Create `patches/pi-loadout-agent-dir.patch` against the output of the two existing `pi-loadout` patches. Import `getAgentDir` from `@earendil-works/pi-coding-agent`, build `GLOBAL_LOADOUT_PATH` and `PROFILES_PATH` from it, create that directory before writes, and drop the unused `homedir` import. Append the patch to `piLoadout.patches` in `nix/packages/pi-deps.nix`.

`getAgentDir()` is Pi's public resolver. It returns `PI_CODING_AGENT_DIR` when set and `~/.pi/agent` otherwise, so the Home Manager installation keeps its current paths.

The README devenv example sets `PI_CODING_AGENT_DIR` but does not link the loadout files. Add `loadout.json` and `loadout-profiles.json` to its resource loop so that setup keeps the packaged default loadout.

- [ ] **Step 4: Confirm GREEN and commit**

```bash
git add patches/pi-loadout-agent-dir.patch nix/packages/pi-deps.nix README.md
nix build .#checks.x86_64-linux.pi-loadout-runtime --no-link
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
git commit -m "fix(loadout): read loadout files from the Pi agent directory"
```

Expected: PASS.

- [ ] **Step 5: Add the failing `pi-den` runtime check**

Extend `modules/checks/pi-den.nix`:

```nix
checks.pi-den-runtime = import ../../nix/check-support/pi-den-runtime.nix {
  inherit pkgs;
  piDen = self'.packages.pi-den;
  piConfig = self'.packages.pi-config;
  probeExtension = ../../nix/check-support/pi-skillset-probe.ts;
  bootstrapProbe = ../../nix/check-support/pi-bootstrap-probe.ts;
};
```

Create `nix/check-support/pi-den-runtime.nix`. It must use `piDen.denPackage.denManifest` and `piDen.denSettings` and prove these behaviors rather than inspecting Nix source:

1. `$out/bin` contains only `pi-den`; it contains no `pi` command.
2. `pi-den` is a symlink to the Den Pi command, so argument and status behavior stays with Den.
3. The manifest argument policy is `pi-1.0.2`.
4. The generated Den settings omit `packages` and set `lastChangelogVersion` to `1.0.2`.
5. The manifest has exactly the nine approved `agent` managed destinations and no managed files on the session binding.
6. The bundle's package roots appear in the manifest resource arguments.
7. Fresh custom agent/session directories receive all nine managed links.
8. Replacing `settings.json` with a regular file is corrected on the next launch.
9. `auth.json` and `profiles/pi-subagents/custom.json` keep their exact contents.
10. A `profiles` parent symlink stops the launch, names the unsafe managed destination, and leaves the outside directory unchanged.
11. Directly starting Den's packaged Pi executable with the manifest's controlled environment/resource arguments and `pi-skillset-probe.ts` loads the packaged extensions and skills without `Failed to load extension`, `No such built-in module`, or `Cannot find package`.
12. Starting Den's packaged Pi executable the same way with `pi-bootstrap-probe.ts` applies the packaged default loadout from the managed `loadout.json`: the visible skills equal the default profile's enabled skills minus the catalog's manual skills, and the Superpowers bootstrap is present.

Use the same known-valid test-only RepoWolf tuple from the Den prerequisite plan. Wrap each real `pi-den` launch in `timeout 20`; require a non-zero non-timeout status because the invocation uses `--provider __invalid__` after managed restoration.

For the direct Pi resource probe, construct the child inputs from the manifest:

```bash
agentExecutable=$(jq -r .agent.executable "$manifest")
packageDirName=$(jq -r .agent.packageDirectory.name "$manifest")
packageDirValue=$(jq -r .agent.packageDirectory.value "$manifest")
mapfile -t resourceArgs < <(jq -r '.agent.resourceArgs[]' "$manifest")

export PI_CODING_AGENT_DIR="$agentDir"
export PI_CODING_AGENT_SESSION_DIR="$sessionDir"
export PI_OFFLINE=1
export "$packageDirName=$packageDirValue"
PI_SKILLSET_PROBE_OUTPUT="$TMPDIR/pi-resources.json" \
  "$agentExecutable" \
  "${resourceArgs[@]}" \
  --no-session --no-tools \
  --extension "$probeExtension" \
  -p /write-skillset-probe \
  > "$TMPDIR/pi-resources.log" 2>&1
```

Assert the resulting JSON contains representative package-provided and local skills (`context-mode`, `pi-subagents`, `using-superpowers`, `commit`, and `nix-config`).

- [ ] **Step 6: Stage the check and confirm RED**

```bash
git add nix/check-support/pi-den-runtime.nix modules/checks/pi-den.nix
nix build .#checks.x86_64-linux.pi-den-runtime --no-link
```

Expected: FAIL because `packages.pi-den` does not exist.

- [ ] **Step 7: Implement the focused `pi-den` package**

Create `nix/packages/pi-den.nix`:

```nix
{
  pkgs,
  mkPi,
  piConfig,
  denBundle,
  extraPkgs,
  piVersion,
}:
let
  piSettings = import ../lib/pi-settings.nix { inherit (pkgs) lib; };
  denSettingsValue = builtins.removeAttrs (piSettings {
    inherit piVersion;
    packagePaths = [ ];
  }) [ "packages" ];
  denSettings = pkgs.writeText "roche-pi-den-settings.json"
    (builtins.toJSON denSettingsValue);

  denPackage = mkPi {
    bundles = [ denBundle ];
    inherit extraPkgs;
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
  };
in
pkgs.runCommand "pi-den"
  {
    meta.mainProgram = "pi-den";
    passthru = { inherit denPackage denSettings; };
  }
  ''
    mkdir -p "$out/bin"
    ln -s ${denPackage}/bin/pi "$out/bin/pi-den"
  ''
```

Do not add a shell wrapper around the symlink. Den remains responsible for argv handling, signals, and exit status.

- [ ] **Step 8: Wire the flake package with the approved tools**

Create `modules/packages/pi-den.nix`:

```nix
{ inputs, ... }:
{
  perSystem = { self', system, pkgs, ... }: {
    packages.pi-den = import ../../nix/packages/pi-den.nix {
      inherit pkgs;
      mkPi = inputs.den.lib.${system}.mkPi;
      piConfig = self'.packages.pi-config;
      denBundle = self'.packages.den-bundle;
      piVersion = "1.0.2";
      extraPkgs = [
        self'.packages.codegraph
        self'.packages.codegraph-viz
        self'.packages.notion-cli
      ];
    };
  };
}
```

The runtime check's comparison between `piVersion`, settings, and the manifest policy is the drift alarm for a future Den Pi update.

- [ ] **Step 9: Run package and behavior checks**

```bash
git add nix/packages/pi-den.nix modules/packages/pi-den.nix
nix build .#packages.x86_64-linux.pi-den --no-link
nix build .#checks.x86_64-linux.pi-den-runtime --no-link
nix build .#checks.x86_64-linux.den-bundle-claude --no-link
```

Expected: PASS.

- [ ] **Step 10: Commit `pi-den`**

```bash
git commit -m "feat(nix): publish managed Pi Den package"
```

### Task 4: Document usage and run release-grade verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the final flake outputs.
- Produces: direct-launch and reusable-bundle instructions with a clear mutable-state boundary.

- [ ] **Step 1: Add the Den usage section**

Add a `## Den sandbox usage` section after Home Manager usage. Include:

```bash
nix run github:rochecompaan/pi-config#pi-den
```

and the consumer example:

```nix
programs.den.pi.bundles = [
  inputs.roche-pi.packages.${pkgs.system}.den-bundle
];

programs.den.claude.bundles = [
  inputs.roche-pi.packages.${pkgs.system}.den-bundle
];
```

Explain:

- `pi-den` does not read host `~/.pi/agent` unless the caller explicitly selects that valid path.
- Den restores the nine packaged paths before every launch.
- Authentication, sessions, caches, trust decisions, Context Mode data, extra profiles, and unrecognized paths remain mutable.
- The bundle injects resources but does not select runtime helper packages for consumers.
- RepoWolf environment variables remain runtime secrets and must not be written into Nix files.

Do not advertise `multi-model-planning-teams` or `agent-teams` as Den resources.

- [ ] **Step 2: Verify output discovery and documentation commands**

The Testing Value Gate excludes a test that asserts README text. Verify the documented outputs directly:

```bash
nix flake show --all-systems | grep -E 'den-bundle|pi-den'
nix build .#packages.x86_64-linux.den-bundle --no-link
nix build .#packages.x86_64-linux.pi-den --no-link
```

Expected: both packages are present and build.

- [ ] **Step 3: Run the mandatory focused checks**

```bash
nix build .#checks.x86_64-linux.den-bundle-claude --no-link
nix build .#checks.x86_64-linux.pi-den-runtime --no-link
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Expected: PASS.

- [ ] **Step 4: Run the full flake check**

```bash
nix flake check --accept-flake-config --print-build-logs
```

Expected: PASS with no `Failed to load extension`, `No such built-in module`, or `Cannot find package` diagnostic.

- [ ] **Step 5: Perform the manual managed-state smoke test**

Use a temporary state root and the same test-only RepoWolf tuple used by the automated check:

```bash
result=$(nix build .#packages.x86_64-linux.pi-den --no-link --print-out-paths)
root=$(mktemp -d)
chmod 0700 "$root"
mkdir -m 0700 "$root/home"
printf certificate > "$root/ca.pem"
chmod 0400 "$root/ca.pem"

export HOME="$root/home"
export PI_CODING_AGENT_DIR="$root/agent"
export PI_CODING_AGENT_SESSION_DIR="$root/sessions"
export REPOWOLF_ENDPOINT=https://broker.example.test/
export REPOWOLF_TOKEN=rw1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
export REPOWOLF_CA_FILE="$root/ca.pem"

set +e
timeout 20 "$result/bin/pi-den" --no-tools --provider __invalid__ -p smoke
firstStatus=$?
set -e
test "$firstStatus" -ne 0
test "$firstStatus" -ne 124
test -L "$root/agent/settings.json"
rm "$root/agent/settings.json"
printf changed > "$root/agent/settings.json"
printf keep > "$root/agent/auth.json"

set +e
timeout 20 "$result/bin/pi-den" --no-tools --provider __invalid__ -p smoke
secondStatus=$?
set -e
test "$secondStatus" -ne 0
test "$secondStatus" -ne 124
test -L "$root/agent/settings.json"
test "$(cat "$root/agent/auth.json")" = keep
rm -rf "$root"
```

Expected: both invocations reach an intentional later failure, the managed settings leaf is restored as a link, and mutable auth remains unchanged.

- [ ] **Step 6: Commit documentation**

```bash
git add README.md
git commit -m "docs: explain Den bundle and pi-den usage"
```

## Final Review and Branch Completion

- [ ] Confirm the branch is clean and review the complete diff:

```bash
git status --short
git diff --stat main...HEAD
git log --oneline main..HEAD
```

- [ ] Request adversarial review against `docs/specs/2026-09-27-den-bundle-design.md`, using `main` as base and the current branch head as the review target. Ask the reviewer to check resource duplication, managed-path completeness, mutable-state preservation, Den version drift, Context Mode state placement, and wrapper command collisions.

- [ ] Apply review feedback with the `receiving-code-review` workflow, rerun the three focused checks and full flake check, then present branch-completion options.

- [ ] When the user chooses local integration, squash-merge this branch into `main` as one commit unless the user explicitly requests preservation of individual commits.
