# pi-local-auth Settings Sync and Auth Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconcile project-local Pi settings from the effective global settings on every `pi-local-auth` run and show the active local/global auth mode in Pi's built-in status line.

**Architecture:** `pi-local-auth` will stage a `jq` merge from `$HOME/.pi/agent/settings.json`, atomically replace the managed local settings file, and only then reconcile `.envrc`. A dedicated global TypeScript extension will classify the normalized `PI_CODING_AGENT_DIR` and publish a theme-aware persistent status entry without inspecting credentials or replacing Pi's footer.

**Tech Stack:** Bash, Python's strict JSON parser, jq, Nix flakes and `pkgs.writeShellApplication`, TypeScript Pi extensions, Node's built-in test runner (`node:test`), Pi `ctx.ui.setStatus` and semantic theme colors.

## Global Constraints

- Follow `docs/specs/2026-07-30-pi-local-auth-settings-sync-design.md`.
- `~/.pi/agent/settings.json` is the sole settings source of truth.
- Always override local `sessionDir`, `extensions`, `skills`, `prompts`, and `themes` with the approved `~/.pi/agent/...` paths.
- Reconcile settings on every successful `pi-local-auth` run; repository-specific settings overrides are unsupported.
- Never read, modify, remove, or relink `.pi/local-agent/auth.json`.
- Missing, unreadable, empty, malformed, non-RFC numeric, multi-document, or non-object global settings must leave existing local settings and `.envrc` unchanged.
- Generate settings in a physically verified project-local `.pi/local-agent/` and replace the destination with an atomic same-directory rename that treats the destination as a file; reject symlinked `.pi`/`.pi/local-agent` parents and an existing settings directory, but replace any existing settings symlink without following it.
- Run strict Python validation with isolated imports (`python3 -I`) so project files cannot shadow the standard-library `json` module.
- Do not add resource symlinks or modify Pi upstream.
- Classify auth mode only from normalized `PI_CODING_AGENT_DIR`; do not inspect or resolve `auth.json`.
- Render `auth: LOCAL` with theme `success` and `auth: GLOBAL` with theme `warning` under status key `auth-scope`.
- Do not replace Pi's built-in footer and do nothing in non-UI modes.
- Use behavior-focused automated tests; do not add tests that merely assert Nix or documentation text.
- When delegating implementation, pass both `test-driven-development` and `verification-before-completion` to workers that change production behavior.

---

### Task 1: Reconcile local settings from the effective global file

**Files:**
- Modify: `scripts/pi-local-auth-check.sh:1-56`
- Modify: `scripts/pi-local-auth.sh:1-48`
- Modify: `modules/packages/pi-local-auth.nix:1-31`

**Interfaces:**
- Consumes: `$HOME/.pi/agent/settings.json`, the current working directory, and optional existing `.envrc` assignments.
- Produces: `.pi/local-agent/settings.json` containing the global object plus the five fixed routing overrides.
- Preserves: `.pi/local-agent/auth.json`, other local runtime files, and existing custom `.envrc` assignments.
- Failure contract: nonzero exit; prior local settings and `.envrc` remain byte-for-byte unchanged.

- [ ] **Step 1: Replace the shell check with failing reconciliation regressions**

Replace `scripts/pi-local-auth-check.sh` with:

```bash
#!/usr/bin/env bash
set -eu

: "${PI_LOCAL_AUTH_BIN:?Set PI_LOCAL_AUTH_BIN to the pi-local-auth executable path}"

make_global_home() {
  local home_dir
  home_dir=$(mktemp -d)
  mkdir -p "$home_dir/.pi/agent"
  cat > "$home_dir/.pi/agent/settings.json" <<'EOF'
{
  "globalMarker": "from-home",
  "defaultModel": "global-model",
  "nested": { "preserved": { "value": 42 } },
  "packages": ["global-package"],
  "voice": { "enabled": true, "localModel": "parakeet-v3" },
  "sessionDir": "global-session",
  "extensions": ["global-extension"],
  "skills": ["global-skill"],
  "prompts": ["global-prompt"],
  "themes": ["global-theme"]
}
EOF
  printf '%s\n' "$home_dir"
}

assert_routing_overrides() {
  local file=$1
  jq -e '
    .sessionDir == "~/.pi/agent/sessions" and
    .extensions == ["~/.pi/agent/extensions"] and
    .skills == ["~/.pi/agent/skills"] and
    .prompts == ["~/.pi/agent/prompts"] and
    .themes == ["~/.pi/agent/themes"]
  ' "$file"
}

assert_no_temp_settings() {
  local temp
  for temp in .pi/local-agent/.settings.json.tmp.* .pi/local-agent/.settings-source.tmp.*; do
    [ ! -e "$temp" ] || return 1
  done
}

global_home=$(make_global_home)
export HOME="$global_home"

workdir=$(mktemp -d)
cd "$workdir"
"$PI_LOCAL_AUTH_BIN"

test -f .pi/local-agent/settings.json
jq -e '
  .globalMarker == "from-home" and
  .defaultModel == "global-model" and
  .nested.preserved.value == 42 and
  .packages == ["global-package"] and
  .voice.enabled == true and
  .voice.localModel == "parakeet-v3"
' .pi/local-agent/settings.json
assert_routing_overrides .pi/local-agent/settings.json
grep -Fx 'export PI_CODING_AGENT_DIR="$PWD/.pi/local-agent"' .envrc
grep -Fx 'export PI_CODING_AGENT_SESSION_DIR="$HOME/.pi/agent/sessions"' .envrc

case_existing_settings=$(mktemp -d)
cd "$case_existing_settings"
mkdir -p .pi/local-agent
printf '%s\n' '{"custom":true}' > .pi/local-agent/settings.json
"$PI_LOCAL_AUTH_BIN"
jq -e '.globalMarker == "from-home" and (.custom | not)' .pi/local-agent/settings.json
assert_routing_overrides .pi/local-agent/settings.json

case_existing_symlink=$(mktemp -d)
cd "$case_existing_symlink"
mkdir -p .pi/local-agent
printf '%s\n' '{"stale":true}' > stale-settings.json
ln -s "$case_existing_symlink/stale-settings.json" .pi/local-agent/settings.json
"$PI_LOCAL_AUTH_BIN"
[ ! -L .pi/local-agent/settings.json ]
jq -e '.globalMarker == "from-home" and (.stale | not)' .pi/local-agent/settings.json
grep -Fx '{"stale":true}' stale-settings.json

updated_global=$(mktemp "$HOME/.pi/agent/.settings.json.tmp.XXXXXX")
jq '.globalMarker = "updated-home" | .nested.preserved.value = 84' \
  "$HOME/.pi/agent/settings.json" > "$updated_global"
mv "$updated_global" "$HOME/.pi/agent/settings.json"
cd "$workdir"
"$PI_LOCAL_AUTH_BIN"
jq -e '.globalMarker == "updated-home" and .nested.preserved.value == 84' \
  .pi/local-agent/settings.json

case_auth=$(mktemp -d)
cd "$case_auth"
mkdir -p .pi/local-agent
printf '%s\n' 'project-auth-contents' > .pi/local-agent/auth.json
cp .pi/local-agent/auth.json auth.expected
"$PI_LOCAL_AUTH_BIN"
cmp auth.expected .pi/local-agent/auth.json

case_existing_dir=$(mktemp -d)
cd "$case_existing_dir"
printf '%s\n' 'export PI_CODING_AGENT_DIR="custom"' > .envrc
"$PI_LOCAL_AUTH_BIN"
grep -Fx 'export PI_CODING_AGENT_DIR="custom"' .envrc
grep -Fx 'export PI_CODING_AGENT_SESSION_DIR="$HOME/.pi/agent/sessions"' .envrc
[ "$(grep -c 'PI_CODING_AGENT_DIR=' .envrc)" -eq 1 ]

case_existing_session=$(mktemp -d)
cd "$case_existing_session"
printf '%s\n' 'PI_CODING_AGENT_SESSION_DIR=custom-session' > .envrc
"$PI_LOCAL_AUTH_BIN"
grep -Fx 'PI_CODING_AGENT_SESSION_DIR=custom-session' .envrc
grep -Fx 'export PI_CODING_AGENT_DIR="$PWD/.pi/local-agent"' .envrc
[ "$(grep -c 'PI_CODING_AGENT_SESSION_DIR=' .envrc)" -eq 1 ]

case_idempotent=$(mktemp -d)
cd "$case_idempotent"
"$PI_LOCAL_AUTH_BIN"
cp .pi/local-agent/settings.json settings.expected
"$PI_LOCAL_AUTH_BIN"
cmp settings.expected .pi/local-agent/settings.json
[ "$(grep -c 'PI_CODING_AGENT_DIR=' .envrc)" -eq 1 ]
[ "$(grep -c 'PI_CODING_AGENT_SESSION_DIR=' .envrc)" -eq 1 ]

invalid_home=$(mktemp -d)
mkdir -p "$invalid_home/.pi/agent"
printf '%s\n' '{invalid' > "$invalid_home/.pi/agent/settings.json"
case_invalid=$(mktemp -d)
cd "$case_invalid"
mkdir -p .pi/local-agent
printf '%s\n' '{"sentinel":"settings"}' > .pi/local-agent/settings.json
printf '%s\n' 'KEEP=invalid' > .envrc
cp .pi/local-agent/settings.json settings.before
cp .envrc envrc.before
set +e
HOME="$invalid_home" "$PI_LOCAL_AUTH_BIN" > command.stdout 2> command.stderr
invalid_status=$?
set -e
[ "$invalid_status" -ne 0 ]
grep -F 'pi-local-auth: invalid global settings:' command.stderr
cmp settings.before .pi/local-agent/settings.json
cmp envrc.before .envrc
assert_no_temp_settings

missing_home=$(mktemp -d)
case_missing=$(mktemp -d)
cd "$case_missing"
mkdir -p .pi/local-agent
printf '%s\n' '{"sentinel":"settings"}' > .pi/local-agent/settings.json
printf '%s\n' 'KEEP=missing' > .envrc
cp .pi/local-agent/settings.json settings.before
cp .envrc envrc.before
set +e
HOME="$missing_home" "$PI_LOCAL_AUTH_BIN" > command.stdout 2> command.stderr
missing_status=$?
set -e
[ "$missing_status" -ne 0 ]
grep -F 'pi-local-auth: global settings not found or unreadable:' command.stderr
cmp settings.before .pi/local-agent/settings.json
cmp envrc.before .envrc
assert_no_temp_settings

assert_rejected_global_content() {
  local label=$1
  local content=$2
  local rejected_home
  local case_dir
  local command_status

  rejected_home=$(mktemp -d)
  mkdir -p "$rejected_home/.pi/agent"
  printf '%s' "$content" > "$rejected_home/.pi/agent/settings.json"

  case_dir=$(mktemp -d)
  cd "$case_dir"
  mkdir -p .pi/local-agent
  printf '%s\n' '{"sentinel":"settings"}' > .pi/local-agent/settings.json
  printf '%s\n' "KEEP=$label" > .envrc
  cp .pi/local-agent/settings.json settings.before
  cp .envrc envrc.before

  set +e
  HOME="$rejected_home" "$PI_LOCAL_AUTH_BIN" > command.stdout 2> command.stderr
  command_status=$?
  set -e

  [ "$command_status" -ne 0 ]
  grep -F 'pi-local-auth: invalid global settings:' command.stderr
  cmp settings.before .pi/local-agent/settings.json
  cmp envrc.before .envrc
  assert_no_temp_settings
}

assert_rejected_global_content empty ''
assert_rejected_global_content multiple $'{"one":1}\n{"two":2}\n'
assert_rejected_global_content non-object '[]'
assert_rejected_global_content nan '{"bad":NaN}'
assert_rejected_global_content infinity '{"bad":Infinity}'
assert_rejected_global_content plus-number '{"bad":+1}'
assert_rejected_global_content leading-zero '{"bad":01}'
assert_rejected_global_content leading-decimal '{"bad":.5}'

case_settings_directory=$(mktemp -d)
cd "$case_settings_directory"
mkdir -p .pi/local-agent/settings.json
printf '%s\n' 'keep-directory-content' > .pi/local-agent/settings.json/keep
printf '%s\n' 'KEEP=directory' > .envrc
cp .envrc envrc.before
set +e
"$PI_LOCAL_AUTH_BIN" > command.stdout 2> command.stderr
directory_status=$?
set -e
[ "$directory_status" -ne 0 ]
grep -F 'pi-local-auth: could not replace local settings:' command.stderr
test -d .pi/local-agent/settings.json
grep -Fx 'keep-directory-content' .pi/local-agent/settings.json/keep
cmp envrc.before .envrc
assert_no_temp_settings

case_settings_symlink_directory=$(mktemp -d)
cd "$case_settings_symlink_directory"
mkdir -p .pi/local-agent settings-target
printf '%s\n' 'keep-target-content' > settings-target/keep
ln -s "$case_settings_symlink_directory/settings-target" .pi/local-agent/settings.json
"$PI_LOCAL_AUTH_BIN"
[ ! -L .pi/local-agent/settings.json ]
test -f .pi/local-agent/settings.json
jq -e '.globalMarker == "updated-home"' .pi/local-agent/settings.json
assert_routing_overrides .pi/local-agent/settings.json
grep -Fx 'keep-target-content' settings-target/keep
grep -Fx 'export PI_CODING_AGENT_DIR="$PWD/.pi/local-agent"' .envrc

case_python_shadow=$(mktemp -d)
cd "$case_python_shadow"
cat > json.py <<'PY'
from pathlib import Path

Path("json-imported").write_text("yes")
raise RuntimeError("project json.py imported")
PY
"$PI_LOCAL_AUTH_BIN"
[ ! -e json-imported ]
jq -e '.globalMarker == "updated-home"' .pi/local-agent/settings.json

case_agent_dir_symlink=$(mktemp -d)
cd "$case_agent_dir_symlink"
mkdir -p .pi
ln -s "$HOME/.pi/agent" .pi/local-agent
cp "$HOME/.pi/agent/settings.json" global-settings.before
printf '%s\n' 'KEEP=agent-dir-symlink' > .envrc
cp .envrc envrc.before
set +e
"$PI_LOCAL_AUTH_BIN" > command.stdout 2> command.stderr
agent_dir_symlink_status=$?
set -e
[ "$agent_dir_symlink_status" -ne 0 ]
grep -F 'pi-local-auth: local agent directory resolves outside the project:' command.stderr
cmp global-settings.before "$HOME/.pi/agent/settings.json"
cmp envrc.before .envrc
[ -L .pi/local-agent ]

case_pi_dir_symlink=$(mktemp -d)
pi_dir_target=$(mktemp -d)
cd "$case_pi_dir_symlink"
ln -s "$pi_dir_target" .pi
cp "$HOME/.pi/agent/settings.json" global-settings.before
printf '%s\n' 'KEEP=pi-dir-symlink' > .envrc
cp .envrc envrc.before
set +e
"$PI_LOCAL_AUTH_BIN" > command.stdout 2> command.stderr
pi_dir_symlink_status=$?
set -e
[ "$pi_dir_symlink_status" -ne 0 ]
grep -F 'pi-local-auth: local agent directory resolves outside the project:' command.stderr
cmp global-settings.before "$HOME/.pi/agent/settings.json"
cmp envrc.before .envrc
[ -L .pi ]

if [ -n "${out:-}" ]; then
  touch "$out"
fi
```

- [ ] **Step 2: Run the focused check and verify the new behavior fails**

Run:

```bash
nix build .#checks.x86_64-linux.pi-local-auth --no-link
```

Expected: FAIL. The current packaged command reads its Nix-store template instead of the temporary `$HOME/.pi/agent/settings.json`, so the `globalMarker == "from-home"` assertion or a later missing/invalid-source assertion fails.

- [ ] **Step 3: Implement atomic reconciliation in the shell command**

Replace `scripts/pi-local-auth.sh` with:

```bash
#!/usr/bin/env bash
set -eu

local_agent_dir=".pi/local-agent"
settings_file="$local_agent_dir/settings.json"
global_settings_file="$HOME/.pi/agent/settings.json"
envrc_file=".envrc"
settings_source_tmp=""
settings_tmp=""

cleanup_settings_tmp() {
  if [ -n "$settings_source_tmp" ]; then
    rm -f -- "$settings_source_tmp"
  fi
  if [ -n "$settings_tmp" ]; then
    rm -f -- "$settings_tmp"
  fi
}

if [ ! -r "$global_settings_file" ]; then
  printf 'pi-local-auth: global settings not found or unreadable: %s\n' \
    "$global_settings_file" >&2
  exit 1
fi

if [ -L ".pi" ] || [ -L "$local_agent_dir" ]; then
  printf 'pi-local-auth: local agent directory resolves outside the project: %s\n' \
    "$local_agent_dir" >&2
  exit 1
fi

mkdir -p "$local_agent_dir"
project_dir=$(pwd -P)
resolved_local_agent_dir=$(cd "$local_agent_dir" && pwd -P)
if [ "$resolved_local_agent_dir" != "$project_dir/$local_agent_dir" ]; then
  printf 'pi-local-auth: local agent directory resolves outside the project: %s\n' \
    "$local_agent_dir" >&2
  exit 1
fi

trap cleanup_settings_tmp EXIT HUP INT TERM
settings_source_tmp=$(mktemp "$local_agent_dir/.settings-source.tmp.XXXXXX")

if ! cp -- "$global_settings_file" "$settings_source_tmp"; then
  printf 'pi-local-auth: global settings not found or unreadable: %s\n' \
    "$global_settings_file" >&2
  exit 1
fi

if ! python3 -I - "$settings_source_tmp" <<'PY'
import json
import sys


def reject_constant(value):
    raise ValueError(f"non-standard JSON constant: {value}")


try:
    with open(sys.argv[1], encoding="utf-8") as settings_file:
        settings = json.load(settings_file, parse_constant=reject_constant)
except (OSError, UnicodeError, ValueError):
    raise SystemExit(1)

if not isinstance(settings, dict):
    raise SystemExit(1)
PY
then
  printf 'pi-local-auth: invalid global settings: %s\n' "$global_settings_file" >&2
  exit 1
fi

settings_tmp=$(mktemp "$local_agent_dir/.settings.json.tmp.XXXXXX")

if ! jq --slurp '
  if length != 1 or (.[0] | type) != "object" then
    error("settings must contain exactly one JSON object")
  else
    .[0] + {
      sessionDir: "~/.pi/agent/sessions",
      extensions: ["~/.pi/agent/extensions"],
      skills: ["~/.pi/agent/skills"],
      prompts: ["~/.pi/agent/prompts"],
      themes: ["~/.pi/agent/themes"]
    }
  end
' "$settings_source_tmp" > "$settings_tmp"; then
  printf 'pi-local-auth: invalid global settings: %s\n' "$global_settings_file" >&2
  exit 1
fi

if ! mv -fT -- "$settings_tmp" "$settings_file"; then
  printf 'pi-local-auth: could not replace local settings: %s\n' "$settings_file" >&2
  exit 1
fi
settings_tmp=""
rm -f -- "$settings_source_tmp"
settings_source_tmp=""
trap - EXIT HUP INT TERM

touch "$envrc_file"

if ! grep -q '^[[:space:]]*\(export[[:space:]]\+\)\?PI_CODING_AGENT_DIR=' "$envrc_file"; then
  # shellcheck disable=SC2016
  printf '%s\n' 'export PI_CODING_AGENT_DIR="$PWD/.pi/local-agent"' >> "$envrc_file"
fi

if ! grep -q '^[[:space:]]*\(export[[:space:]]\+\)\?PI_CODING_AGENT_SESSION_DIR=' "$envrc_file"; then
  # shellcheck disable=SC2016
  printf '%s\n' 'export PI_CODING_AGENT_SESSION_DIR="$HOME/.pi/agent/sessions"' >> "$envrc_file"
fi
```

This removes the one-time guard and fallback output. The destination is only replaced after `jq` has produced a complete valid object in the destination directory.

- [ ] **Step 4: Remove the build-time template override from the Nix wrapper**

Replace `modules/packages/pi-local-auth.nix` with:

```nix
{ ... }:
{
  perSystem =
    { pkgs, ... }:
    let
      piLocalAuth = pkgs.writeShellApplication {
        name = "pi-local-auth";
        runtimeInputs = [
          pkgs.coreutils
          pkgs.gnugrep
          pkgs.jq
          pkgs.python3
        ];
        text = ''
          # shellcheck disable=SC1091
          source ${../../scripts/pi-local-auth.sh}
        '';
      };
    in
    {
      packages."pi-local-auth" = piLocalAuth;

      checks."pi-local-auth" =
        pkgs.runCommand "pi-local-auth-check" { nativeBuildInputs = [ pkgs.jq ]; }
          ''
            export PI_LOCAL_AUTH_BIN=${piLocalAuth}/bin/pi-local-auth
            # shellcheck disable=SC1091
            source ${../../scripts/pi-local-auth-check.sh}
          '';
    };
}
```

- [ ] **Step 5: Format and run the focused check**

Run:

```bash
nix fmt modules/packages/pi-local-auth.nix
nix build .#checks.x86_64-linux.pi-local-auth --no-link
```

Expected: formatting exits 0 and the Nix check succeeds. The check proves global setting preservation, fixed routing overrides, isolated strict RFC validation from an immutable snapshot (including non-standard numeric and project-module-shadowing rejection), physically project-local destination containment, regular-file and settings-symlink refresh (including symlink-to-directory), parent/destination directory rejection, rerun synchronization, auth preservation, `.envrc` idempotence, and failure atomicity.

- [ ] **Step 6: Review the task diff**

Run:

```bash
git diff --check
git diff -- scripts/pi-local-auth.sh scripts/pi-local-auth-check.sh modules/packages/pi-local-auth.nix
```

Expected: `git diff --check` exits 0. The diff contains no fallback settings, no `PI_LOCAL_AUTH_SETTINGS_TEMPLATE`, and no edits outside the three listed files.

- [ ] **Step 7: Commit the settings reconciliation**

```bash
git add scripts/pi-local-auth.sh scripts/pi-local-auth-check.sh modules/packages/pi-local-auth.nix
git commit -m "fix(pi): sync local auth settings"
```

---

### Task 2: Show local/global auth mode in Pi's status line

**Files:**
- Create: `extensions/auth-scope/index.test.ts`
- Create: `extensions/auth-scope/index.ts`

Use a directory entry point because Pi auto-discovers root-level TypeScript files in `extensions/`; the established `index.ts` pattern keeps the colocated test from loading as an extension.

**Interfaces:**
- Produces: `AuthScopeEnvironment`, `AuthScope`, `classifyAuthScope(environment)`, `renderAuthScopeStatus(scope, theme)`, and the default Pi extension factory.
- Consumes: `PI_CODING_AGENT_DIR`, `os.homedir()`, `process.cwd()`, Pi's `session_start` event, `ctx.hasUI`, `ctx.ui.theme.fg`, and `ctx.ui.setStatus`.
- Status contract: key `auth-scope`; local value uses `success`; global value uses `warning`.

- [ ] **Step 1: Add failing classification and UI behavior tests**

Create `extensions/auth-scope/index.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";

import registerAuthScope, {
	classifyAuthScope,
	renderAuthScopeStatus,
	type AuthScopeEnvironment,
} from "./index.ts";

const homeDir = "/home/tester";
const cwd = "/workspace/project";

function environment(agentDir: string | undefined): AuthScopeEnvironment {
	return { agentDir, homeDir, cwd };
}

test("classifies unset and normalized global agent directories as GLOBAL", () => {
	for (const agentDir of [
		undefined,
		"",
		"   ",
		"/home/tester/.pi/agent",
		"/home/tester/.pi/agent/",
		"~/.pi/agent",
	]) {
		assert.equal(classifyAuthScope(environment(agentDir)), "GLOBAL", String(agentDir));
	}
});

test("classifies non-global agent directories as LOCAL", () => {
	for (const agentDir of [
		".pi/local-agent",
		"/workspace/project/.pi/local-agent",
		"~/.pi/agent-jailed",
	]) {
		assert.equal(classifyAuthScope(environment(agentDir)), "LOCAL", agentDir);
	}
});

test("renders LOCAL as success and GLOBAL as warning", () => {
	const theme = {
		fg(color: "success" | "warning", text: string) {
			return `[${color}]${text}`;
		},
	};

	assert.equal(renderAuthScopeStatus("LOCAL", theme), "[success]auth: LOCAL");
	assert.equal(renderAuthScopeStatus("GLOBAL", theme), "[warning]auth: GLOBAL");
});

type SessionStartHook = (event: unknown, ctx: any) => Promise<void>;

function createHarness() {
	let sessionStart: SessionStartHook | undefined;
	const pi = {
		on(name: string, handler: SessionStartHook) {
			if (name === "session_start") sessionStart = handler;
		},
	};
	return {
		pi,
		getSessionStart() {
			assert.ok(sessionStart);
			return sessionStart;
		},
	};
}

function createContext(hasUI: boolean) {
	const statusCalls: Array<[string, string | undefined]> = [];
	return {
		ctx: {
			hasUI,
			ui: {
				theme: {
					fg(color: "success" | "warning", text: string) {
						return `[${color}]${text}`;
					},
				},
				setStatus(key: string, value: string | undefined) {
					statusCalls.push([key, value]);
				},
			},
		},
		statusCalls,
	};
}

test("publishes themed LOCAL and GLOBAL statuses in UI sessions", async () => {
	for (const [agentDir, expected] of [
		["/workspace/project/.pi/local-agent", "[success]auth: LOCAL"],
		[undefined, "[warning]auth: GLOBAL"],
	] as const) {
		const harness = createHarness();
		const { ctx, statusCalls } = createContext(true);
		registerAuthScope(harness.pi as any, () => environment(agentDir));

		await harness.getSessionStart()({}, ctx);

		assert.deepEqual(statusCalls, [["auth-scope", expected]]);
	}
});

test("does not read environment or publish status without UI", async () => {
	const harness = createHarness();
	const { ctx, statusCalls } = createContext(false);
	let environmentReads = 0;
	registerAuthScope(harness.pi as any, () => {
		environmentReads++;
		return environment("/workspace/project/.pi/local-agent");
	});

	await harness.getSessionStart()({}, ctx);

	assert.equal(environmentReads, 0);
	assert.deepEqual(statusCalls, []);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
node --test --experimental-strip-types extensions/auth-scope/index.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `extensions/auth-scope/index.ts`.

- [ ] **Step 3: Implement the dedicated status extension**

Create `extensions/auth-scope/index.ts`:

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import os from "node:os";
import path from "node:path";

export type AuthScope = "GLOBAL" | "LOCAL";

export interface AuthScopeEnvironment {
	agentDir: string | undefined;
	homeDir: string;
	cwd: string;
}

export interface AuthScopeStatusTheme {
	fg(color: "success" | "warning", text: string): string;
}

export type AuthScopeEnvironmentReader = () => AuthScopeEnvironment;

function normalizeAgentDir(input: string, homeDir: string, cwd: string): string {
	let expanded = input.trim();
	if (expanded === "~") expanded = homeDir;
	else if (expanded.startsWith("~/")) expanded = path.join(homeDir, expanded.slice(2));
	return path.resolve(cwd, expanded);
}

export function classifyAuthScope(environment: AuthScopeEnvironment): AuthScope {
	const globalAgentDir = path.resolve(environment.homeDir, ".pi", "agent");
	const configuredAgentDir = environment.agentDir?.trim();
	if (!configuredAgentDir) return "GLOBAL";
	return normalizeAgentDir(configuredAgentDir, environment.homeDir, environment.cwd) === globalAgentDir
		? "GLOBAL"
		: "LOCAL";
}

export function renderAuthScopeStatus(scope: AuthScope, theme: AuthScopeStatusTheme): string {
	const color = scope === "LOCAL" ? "success" : "warning";
	return theme.fg(color, `auth: ${scope}`);
}

const readEnvironment: AuthScopeEnvironmentReader = () => ({
	agentDir: process.env.PI_CODING_AGENT_DIR,
	homeDir: os.homedir(),
	cwd: process.cwd(),
});

export default function registerAuthScope(
	pi: ExtensionAPI,
	getEnvironment: AuthScopeEnvironmentReader = readEnvironment,
): void {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const scope = classifyAuthScope(getEnvironment());
		ctx.ui.setStatus("auth-scope", renderAuthScopeStatus(scope, ctx.ui.theme));
	});
}
```

Keep the extension independent: do not import helpers from unrelated extensions and do not inspect the filesystem or `auth.json`.

- [ ] **Step 4: Run focused behavior and packaged-load checks**

Run:

```bash
node --test --experimental-strip-types extensions/auth-scope/index.test.ts
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Expected: the Node test reports 5 passing tests with 0 failures, and the extension-load Nix check exits 0 without `Failed to load extension`, missing-module, or missing-package errors.

- [ ] **Step 5: Review the task diff**

Run:

```bash
git diff --check
git diff -- extensions/auth-scope/index.ts extensions/auth-scope/index.test.ts
```

Expected: `git diff --check` exits 0. The extension uses only `setStatus`, semantic `success`/`warning` colors, and `PI_CODING_AGENT_DIR`; it contains no custom footer or auth-file logic.

- [ ] **Step 6: Commit the status indicator**

```bash
git add extensions/auth-scope/index.ts extensions/auth-scope/index.test.ts
git commit -m "feat(pi): show auth scope in status"
```

---

### Task 3: Run complete verification

**Files:**
- Verify: `scripts/pi-local-auth.sh`
- Verify: `scripts/pi-local-auth-check.sh`
- Verify: `modules/packages/pi-local-auth.nix`
- Verify: `extensions/auth-scope/index.ts`
- Verify: `extensions/auth-scope/index.test.ts`

**Interfaces:**
- Consumes: the two independently committed deliverables from Tasks 1 and 2.
- Produces: final evidence that focused behavior, packaged extension loading, formatting, and the complete flake remain healthy.

- [ ] **Step 1: Run the direct TypeScript behavior tests**

```bash
node --test --experimental-strip-types extensions/auth-scope/index.test.ts
```

Expected: 5 tests pass, 0 fail.

- [ ] **Step 2: Run focused Nix checks**

```bash
nix build .#checks.x86_64-linux.pi-local-auth --no-link
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Expected: both builds exit 0.

- [ ] **Step 3: Run the full flake check**

```bash
nix flake check --accept-flake-config --print-build-logs
```

Expected: all flake checks pass. Any extension loading error, missing module, or failed `pi-local-auth` scenario is a blocker.

- [ ] **Step 4: Verify formatting and repository state**

```bash
nix fmt modules/packages/pi-local-auth.nix
git diff --exit-code
git diff --check
git status --short
git log --oneline --decorate -4
```

Expected: the affected Nix file formats successfully and produces no diff; whitespace checks exit 0; `git status --short` is empty; recent history contains the settings-sync and auth-status commits after the documentation commits.

- [ ] **Step 5: Request final code review**

Use the `requesting-code-review` skill and the canonical `reviewer` subagent with fresh context. Provide:

- implementation summary: runtime settings reconciliation plus auth-scope status extension;
- requirements: `docs/specs/2026-07-30-pi-local-auth-settings-sync-design.md`;
- implementation plan: `docs/plans/2026-07-30-pi-local-auth-settings-sync-and-status.md`;
- base SHA: the parent of the first implementation commit;
- head SHA: current `HEAD`;
- verification results from Steps 1-4.

Expected: no unresolved critical or important findings before branch completion.

---

### Task 4: Prevent project shell entry from overwriting synchronized settings

**Files:**
- Modify: `modules/checks/jailed-pi-auth-mode.nix`
- Modify: `modules/lib/project-pi.nix`
- Modify: `docs/specs/2026-07-30-pi-local-auth-settings-sync-design.md`

**Interfaces:**
- `projectPiShellHook` continues to create the jailed agent directory, configure auth mode, prepare the global session directory, export `PI_CODING_AGENT_DIR`, and provide the immutable resource/node-module/global-session links required inside the jail.
- The hook no longer owns agent-local `settings.json`.
- `pi-local-auth` remains the only component that reconciles the local settings file.

- [ ] **Step 1: Add the shell-entry regression**

Extend the existing jailed auth-mode Nix check to prove both global and local hooks preserve an existing regular `settings.json` and do not create settings on a fresh agent directory. Retain assertions for the immutable resource and global-session links, add a fresh-local scenario, and use real Pi RPC calls to prove representative packaged commands load and the session path resolves through the global session directory.

- [ ] **Step 2: Verify the regression fails for the packaged-settings overwrite**

```bash
nix build .#checks.x86_64-linux.jailed-pi-auth-mode --no-link
```

Expected before the fix: the check fails because `projectPiShellHook` creates the packaged `settings.json` symlink.

- [ ] **Step 3: Remove settings ownership from the shell hook**

Remove only the packaged `settings.json` link from `modules/lib/project-pi.nix`. Keep directory creation, immutable resource/node-module links, global session routing, auth setup, and `PI_CODING_AGENT_DIR` export.

- [ ] **Step 4: Verify the focused regression passes**

```bash
nix fmt modules/lib/project-pi.nix modules/checks/jailed-pi-auth-mode.nix
nix build .#checks.x86_64-linux.jailed-pi-auth-mode --no-link
```

Expected: formatting succeeds and the focused check proves repeated shell entry cannot replace synchronized settings while jailed resource discovery and global session routing remain functional.

- [ ] **Step 5: Re-run feature and flake verification**

```bash
nix build .#checks.x86_64-linux.pi-local-auth --no-link
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
```

Expected: settings synchronization, extension loading, jailed auth modes, and the full flake remain green.
