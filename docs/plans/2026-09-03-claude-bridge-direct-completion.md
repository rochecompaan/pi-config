# Claude Bridge Direct Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route direct `ModelRegistry.complete()` requests through Claude Bridge's existing isolated stream while preserving prompt-capture protection for normal agent requests.

**Architecture:** Add a dependency-free request router inside the patched Claude Bridge package. The provider entry point keeps its existing name and global-registration role, but delegates contexts with omitted `tools` to `isolatedStreamFn` and contexts with a present `tools` field to the current capture-protected agent implementation.

**Tech Stack:** TypeScript, Node's built-in test runner, Nix `buildNpmPackage`, Pi's `Context` and `SimpleStreamOptions` provider interfaces, Zellij, Claude Bridge 0.7.0.

## Global Constraints

- Work only in `/home/roche/projects/pi/roche-pi/.worktrees/fix-claude-bridge-direct-completion` on `fix/claude-bridge-direct-completion`.
- Treat `context.tools === undefined` as an isolated direct completion.
- Treat every present `tools` field, including `tools: []`, as a normal agent request.
- Pass the direct request context and its `systemPrompt` to the isolated handler without modification.
- Keep the isolated path tool-free, settings-source-free, skill-free, and non-persistent.
- Do not change `extensions/handoff-generation.ts`, `extensions/handoff.ts`, or their tests.
- Do not weaken `PromptCaptures.resolveOrDerive()` or the rewritten/stripped prompt rejection.
- Do not change Claude history reconstruction or update Claude Bridge 0.7.0.
- Preserve `pi-claude-bridge-history-reconstruction.test.mjs` unchanged.
- Use the exact 883-character `HANDOFF_SYSTEM_PROMPT` in the new regression.
- Do not add an automated test that only restates Nix configuration. Verify Nix wiring through the package build and install check.
- Do not push any branch or commit without explicit permission.

---

## File Map

- Create `nix/packages/pi-claude-bridge-direct-completion.test.mjs`: dependency-free behavioral regression for omitted versus present `tools`.
- Modify `nix/packages/pi-claude-bridge-safe-history-reconstruction.patch`: add upstream `src/request-router.ts`, import it from upstream `src/index.ts`, and split the provider entry wrapper from the unchanged agent handler.
- Modify `nix/packages/pi-deps.nix`: expose the new regression, copy the patched router into the install-check sandbox, and run both bridge regressions in one Node invocation.
- Preserve `nix/packages/pi-claude-bridge-history-reconstruction.test.mjs`: existing transcript fallback and AskClaude session-planning coverage.

---

### Task 1: Add the Packaged Direct-Completion Regression (RED)

**Files:**
- Create: `nix/packages/pi-claude-bridge-direct-completion.test.mjs`
- Modify: `nix/packages/pi-deps.nix:59-100`
- Test: `nix/packages/pi-claude-bridge-direct-completion.test.mjs`

**Interfaces:**
- Consumes: `BRIDGE_DIRECT_COMPLETION_MODULE`, an absolute path to the patched pure TypeScript router.
- Expects: `routeBridgeRequest<TContext extends { tools?: unknown }, TResult>(context, handlers): TResult`.
- Produces: an install-check regression that distinguishes an omitted `tools` property from `tools: []` and checks the exact handoff prompt.

- [ ] **Step 1: Create the failing regression with the exact handoff prompt**

Create `nix/packages/pi-claude-bridge-direct-completion.test.mjs` with:

```javascript
import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

const modulePath = process.env.BRIDGE_DIRECT_COMPLETION_MODULE;
if (!modulePath) {
	throw new Error("BRIDGE_DIRECT_COMPLETION_MODULE is required");
}

const { routeBridgeRequest } = await import(pathToFileURL(modulePath).href);

const HANDOFF_SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new thread should be able to proceed without the old conversation

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" - just output the prompt itself.

Example output format:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
[Clear description of what to do next based on user's goal]`;

const directContext = {
	systemPrompt: HANDOFF_SYSTEM_PROMPT,
	messages: [{ role: "user", content: "Prepare the handoff" }],
};

const simulatedCaptureError = "simulated prompt-capture failure";

test("omitted tools routes the exact handoff prompt to the isolated handler", () => {
	assert.equal(HANDOFF_SYSTEM_PROMPT.length, 883);
	assert.equal("tools" in directContext, false);

	let isolatedContext;
	let agentCalls = 0;
	const result = routeBridgeRequest(directContext, {
		isolated(context) {
			isolatedContext = context;
			return "isolated";
		},
		agent() {
			agentCalls += 1;
			throw new Error(simulatedCaptureError);
		},
	});

	assert.equal(result, "isolated");
	assert.strictEqual(isolatedContext, directContext);
	assert.equal(isolatedContext.systemPrompt, HANDOFF_SYSTEM_PROMPT);
	assert.equal(agentCalls, 0);
});

test("tools: [] stays on the agent handler and surfaces capture failure", () => {
	const agentContext = { ...directContext, tools: [] };
	let isolatedCalls = 0;
	let receivedAgentContext;

	assert.throws(
		() => routeBridgeRequest(agentContext, {
			isolated() {
				isolatedCalls += 1;
				return "isolated";
			},
			agent(context) {
				receivedAgentContext = context;
				throw new Error(simulatedCaptureError);
			},
		}),
		{ message: simulatedCaptureError },
	);

	assert.equal(isolatedCalls, 0);
	assert.strictEqual(receivedAgentContext, agentContext);
});
```

- [ ] **Step 2: Wire the regression into `pi-deps.nix` before adding the router**

Add the test path beside the existing bridge test binding:

```nix
piClaudeBridgePatch = ./pi-claude-bridge-safe-history-reconstruction.patch;
piClaudeBridgeHistoryReconstructionTest = ./pi-claude-bridge-history-reconstruction.test.mjs;
piClaudeBridgeDirectCompletionTest = ./pi-claude-bridge-direct-completion.test.mjs;
```

Replace the bridge install-check test block with:

```nix
bridgeHistoryModule="$TMPDIR/history-reconstruction.ts"
bridgeDirectCompletionModule="$TMPDIR/request-router.ts"
cp "$out/lib/node_modules/pi-claude-bridge/src/history-reconstruction.ts" "$bridgeHistoryModule"
cp "$out/lib/node_modules/pi-claude-bridge/src/request-router.ts" "$bridgeDirectCompletionModule"
BRIDGE_HISTORY_MODULE="$bridgeHistoryModule" \
  BRIDGE_DIRECT_COMPLETION_MODULE="$bridgeDirectCompletionModule" \
  ${pkgs.nodejs}/bin/node --test --experimental-strip-types \
    ${piClaudeBridgeHistoryReconstructionTest} \
    ${piClaudeBridgeDirectCompletionTest}
```

- [ ] **Step 3: Run the package build and confirm the regression is red**

Run:

```sh
nix build .#packages.x86_64-linux.pi-config --no-link
```

Expected: FAIL in the Claude Bridge install check because patched `src/request-router.ts` does not exist yet. The failure must come from the new regression wiring, not from the existing history regression.

- [ ] **Step 4: Inspect the red diff before implementation**

Run:

```sh
git diff --check
git diff -- \
  nix/packages/pi-claude-bridge-direct-completion.test.mjs \
  nix/packages/pi-deps.nix
```

Expected: no whitespace errors; only the new regression and its install-check wiring are present.

---

### Task 2: Add the Pure Router and Provider Wrapper (GREEN)

**Files:**
- Modify: `nix/packages/pi-claude-bridge-safe-history-reconstruction.patch`
- Test: `nix/packages/pi-claude-bridge-direct-completion.test.mjs`
- Test: `nix/packages/pi-claude-bridge-history-reconstruction.test.mjs`

**Interfaces:**
- Produces upstream `src/request-router.ts` with:

```typescript
export type BridgeRequestHandlers<TContext, TResult> = {
	isolated: (context: TContext) => TResult;
	agent: (context: TContext) => TResult;
};

export function routeBridgeRequest<TContext extends { tools?: unknown }, TResult>(
	context: TContext,
	handlers: BridgeRequestHandlers<TContext, TResult>,
): TResult;
```

- Preserves upstream `streamClaudeAgentSdk(model, context, options)` as the provider registration and global stream identity.
- Introduces upstream `streamClaudeAgentRequest(model, context, options)` as the unchanged capture-protected implementation.

- [ ] **Step 1: Add the dependency-free router to the bridge patch**

Add a new-file diff for upstream `src/request-router.ts` containing:

```typescript
export type BridgeRequestHandlers<TContext, TResult> = {
	isolated: (context: TContext) => TResult;
	agent: (context: TContext) => TResult;
};

export function routeBridgeRequest<TContext extends { tools?: unknown }, TResult>(
	context: TContext,
	handlers: BridgeRequestHandlers<TContext, TResult>,
): TResult {
	return context.tools === undefined
		? handlers.isolated(context)
		: handlers.agent(context);
}
```

The module must not import the Claude SDK, Pi packages, prompt-capture code, or shared-session state.

- [ ] **Step 2: Import the router from the patched bridge entry point**

Add this import to upstream `src/index.ts` through the existing patch:

```typescript
import { routeBridgeRequest } from "./request-router.js";
```

Place it with the other local imports. Do not change the existing history-reconstruction import.

- [ ] **Step 3: Keep the provider entry name and move the old body behind the agent handler**

Replace the start of the current upstream provider function with:

```typescript
function streamClaudeAgentSdk(
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	return routeBridgeRequest(context, {
		isolated: (requestContext) => isolatedStreamFn(model, requestContext, options),
		agent: (requestContext) => streamClaudeAgentRequest(model, requestContext, options),
	});
}

function streamClaudeAgentRequest(
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	showStartupNoticeOnce();
	const stream = newAssistantMessageEventStream();
```

Leave the rest of the former `streamClaudeAgentSdk` body unchanged. In particular, keep this statement only inside `streamClaudeAgentRequest`:

```typescript
const promptCapture = promptCaptures.resolveOrDerive(context.systemPrompt);
```

Do not replace `streamClaudeAgentSdk` in `ACTIVE_STREAM_SIMPLE_KEY`, shutdown cleanup, or `pi.registerProvider()`. Those sites must continue to use the wrapper so first-instance registration and reload behavior stay intact.

- [ ] **Step 4: Verify the bridge package is green through the `pi-config` build**

Run:

```sh
nix build .#packages.x86_64-linux.pi-config --no-link
```

Expected: PASS. The Claude Bridge install check runs both Node regression files. The direct regression proves omitted `tools` uses the isolated handler with the exact prompt and `tools: []` still surfaces the simulated capture error.

- [ ] **Step 5: Confirm the existing isolated-stream safeguards remain intact**

Locate the bridge output and inspect the existing isolated query options:

```sh
bridge="$(nix path-info -r .#packages.x86_64-linux.pi-config \
  | grep -- '-pi-claude-bridge-0.7.0$' \
  | tail -1)"
rg -n -C 2 \
  'tools: \[\]|settingSources: \[\]|persistSession: false|systemPrompt: context\.systemPrompt' \
  "$bridge/lib/node_modules/pi-claude-bridge/src/index.ts"
```

Expected: the isolated stream still uses `tools: []`, `settingSources: []`, `persistSession: false`, and `systemPrompt: context.systemPrompt`. The new wrapper must route to this stream without changing those options or shared-session state.

- [ ] **Step 6: Check patch scope and formatting**

Run:

```sh
git diff --check
git diff --stat
git diff -- \
  nix/packages/pi-claude-bridge-safe-history-reconstruction.patch \
  nix/packages/pi-claude-bridge-direct-completion.test.mjs \
  nix/packages/pi-deps.nix
```

Expected: only the three implementation files from the design change; no edits to handoff or history-reconstruction behavior.

- [ ] **Step 7: Commit the tested provider fix**

```sh
git add \
  nix/packages/pi-claude-bridge-safe-history-reconstruction.patch \
  nix/packages/pi-claude-bridge-direct-completion.test.mjs \
  nix/packages/pi-deps.nix
git commit -m "fix(claude-bridge): isolate direct completions"
```

Do not push.

---

### Task 3: Run Focused Handoff and Bridge Regressions

**Files:**
- Verify: `tests/extensions/handoff-generation.test.ts`
- Verify: `tests/extensions/handoff.test.ts`
- Verify: `nix/packages/pi-claude-bridge-history-reconstruction.test.mjs`
- Verify: `nix/packages/pi-claude-bridge-direct-completion.test.mjs`

**Interfaces:**
- Consumes: the built patched Claude Bridge package from the `pi-config` closure.
- Produces: direct evidence for handoff behavior, request routing, and unchanged history reconstruction.

- [ ] **Step 1: Run the focused handoff tests**

Run:

```sh
node --test --experimental-strip-types \
  tests/extensions/handoff-generation.test.ts \
  tests/extensions/handoff.test.ts
```

Expected: PASS with zero failures.

- [ ] **Step 2: Locate the patched Claude Bridge output used by `pi-config`**

Run:

```sh
bridge="$(nix path-info -r .#packages.x86_64-linux.pi-config \
  | grep -- '-pi-claude-bridge-0.7.0$' \
  | tail -1)"
test -n "$bridge"
printf '%s\n' "$bridge"
```

Expected: one `/nix/store/...-pi-claude-bridge-0.7.0` output path.

- [ ] **Step 3: Run both bridge regressions directly against copied pure modules**

Run:

```sh
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp "$bridge/lib/node_modules/pi-claude-bridge/src/history-reconstruction.ts" \
  "$tmp/history-reconstruction.ts"
cp "$bridge/lib/node_modules/pi-claude-bridge/src/request-router.ts" \
  "$tmp/request-router.ts"
BRIDGE_HISTORY_MODULE="$tmp/history-reconstruction.ts" \
BRIDGE_DIRECT_COMPLETION_MODULE="$tmp/request-router.ts" \
  node --test --experimental-strip-types \
    nix/packages/pi-claude-bridge-history-reconstruction.test.mjs \
    nix/packages/pi-claude-bridge-direct-completion.test.mjs
```

Expected: PASS for every history-reconstruction and direct-completion test.

---

### Task 4: Run Packaged Pi Verification

**Files:**
- Verify: `nix/packages/pi-deps.nix`
- Verify: the full flake and packaged extension startup path.

**Interfaces:**
- Consumes: the patched bridge package and Pi configuration.
- Produces: build, extension-loading, and repository-wide validation evidence.

- [ ] **Step 1: Build `pi-config` explicitly**

Run:

```sh
nix build .#packages.x86_64-linux.pi-config --no-link
```

Expected: PASS, including both Claude Bridge install-check regressions.

- [ ] **Step 2: Run the required runtime extension-load check**

Run:

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Expected: PASS with no `Failed to load extension`, missing built-in module, or missing package error.

- [ ] **Step 3: Run the full flake check**

Run:

```sh
nix flake check --accept-flake-config --print-build-logs
```

Expected: PASS for all checks.

- [ ] **Step 4: Record direct verification instead of a static Nix-content test**

Record that no new test was added solely for `pi-deps.nix`. The successful Claude Bridge install check, `pi-config` build, extension-load check, and full flake check directly verify the Nix wiring.

---

### Task 5: Reproduce `/handoff` in a Temporary Zellij Session

**Files:**
- Verify: built `pi-config` output.
- Do not modify: the installed global Pi configuration.

**Interfaces:**
- Consumes: `PI_CODING_AGENT_DIR=<built pi-config output>` and model `claude-bridge/claude-sonnet-4-6`.
- Produces: live evidence that a normal turn succeeds and `/handoff` reaches the editor without a prompt-capture error.

- [ ] **Step 1: Read and follow the local Claude Zellij workflow**

Read:

```text
/home/roche/.pi/agent/skills/claude-zellij-prompt/SKILL.md
```

Use its session naming, terminal capture, timeout, blocked-UI handling, and cleanup rules.

- [ ] **Step 2: Resolve the built Pi configuration without replacing the installed one**

Run:

```sh
pi_config="$(nix build .#packages.x86_64-linux.pi-config --no-link --print-out-paths)"
test -d "$pi_config/extensions"
printf '%s\n' "$pi_config"
```

Use `PI_CODING_AGENT_DIR="$pi_config"` for the temporary Pi process. Keep the normal home directory so the already-authorized Claude Code installation remains available.

- [ ] **Step 3: Start a uniquely named temporary Zellij session**

Use a name such as:

```sh
session="pi-claude-handoff-$(date +%s)"
```

Start Pi inside that Zellij session with:

```sh
PI_CODING_AGENT_DIR="$pi_config" \
  pi --provider claude-bridge --model claude-sonnet-4-6
```

- [ ] **Step 4: Complete the normal-turn control**

Send:

```text
Reply with exactly: ready
```

Expected: Claude Bridge returns `ready`. Capture the terminal output as evidence that the normal capture-protected path still works.

- [ ] **Step 5: Run the live handoff command**

Send:

```text
/handoff continue this reproduction in a new session
```

Expected: generation completes and the handoff editor opens. The terminal must not show the uncaptured 883-character system-prompt error or another prompt-capture failure.

- [ ] **Step 6: Cancel the editor and clean up the temporary session**

Cancel the handoff editor without starting a new Pi session. Exit Pi, delete the temporary Zellij session, and verify that the session no longer exists.

- [ ] **Step 7: Record the live result**

Record:

```text
normal turn: ready
handoff generation: reached editor
prompt-capture error: absent
temporary Zellij session: removed
```

If the editor does not appear, preserve the captured terminal evidence and return to systematic debugging before changing code.

---

### Task 6: Final Review and Branch State

**Files:**
- Review: all changes from `b6532d2bc6aa8c2a9111277a68b894395b314c92` to `HEAD`.

**Interfaces:**
- Consumes: approved design, implementation diff, automated results, Nix results, and live Zellij evidence.
- Produces: a reviewed local branch with no push.

- [ ] **Step 1: Confirm the worktree and commit scope**

Run:

```sh
git status --short --branch
git log --oneline --decorate \
  b6532d2bc6aa8c2a9111277a68b894395b314c92..HEAD
git diff --check \
  b6532d2bc6aa8c2a9111277a68b894395b314c92..HEAD
git diff --stat \
  b6532d2bc6aa8c2a9111277a68b894395b314c92..HEAD
```

Expected: the approved design, this plan, and the focused provider fix only; no uncommitted implementation changes.

- [ ] **Step 2: Request adversarial code review**

Give the reviewer:

- Approved spec: `docs/specs/2026-09-03-claude-bridge-direct-completion-design.md`
- Plan: `docs/plans/2026-09-03-claude-bridge-direct-completion.md`
- Base: `b6532d2bc6aa8c2a9111277a68b894395b314c92`
- Head: current feature-branch `HEAD`
- Requirements: omitted `tools` isolates; `tools: []` stays capture-protected; exact 883-character prompt; history reconstruction unchanged; no handoff changes.
- Verification evidence from Tasks 3-5.

Expected: no unresolved correctness, security, regression, or scope findings.

- [ ] **Step 3: Re-run affected verification after any review fix**

For a router, patch, or Nix change, rerun Tasks 3 and 4. For any runtime integration change, also rerun Task 5. Do not report stale results after a review fix.

- [ ] **Step 4: Report completion without pushing**

Report the changed files, commits, every verification command and result, the live Zellij outcome, and any residual risk. State explicitly that nothing was pushed.
