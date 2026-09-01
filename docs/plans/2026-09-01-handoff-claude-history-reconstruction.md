# Handoff and Claude History Reconstruction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve handoff generation errors and prevent lossy replay of signed Claude assistant history after Pi tree navigation.

**Architecture:** Harden the existing handoff generation boundary and keep command policy in `handoff.ts`. Apply a local Nix patch to bridge `0.7.0`. Unchanged Claude sessions still resume. Unsafe rebuilds start fresh with plain transcript context.

**Tech Stack:** TypeScript, Node.js test runner, Nix `buildNpmPackage`, `pi-claude-bridge` 0.7.0, `cc-session-io` 0.4.0.

## Global Constraints

- Use TDD for each production behavior change: write the regression, run it red, implement the minimum fix, and run it green.
- Preserve manual editor use for every nonempty manual handoff prompt.
- Return `null` only for explicit generation cancellation.
- Do not accept partial output after `stopReason: "length"`.
- Do not synthesize normalized `claude-bridge` assistant turns during history reconstruction.
- Exclude thinking, signatures, redacted data, and tool IDs from transcript fallback.
- Keep bridge version `0.7.0` and the current package lock.
- Keep the bridge patch local until an upstream release contains equivalent behavior and regression coverage.
- Do not add tests that assert static Nix text. Use the bridge behavior test and Nix build checks instead.
- Stage new Nix-referenced files before normal flake builds so Git-backed flake evaluation includes them.
- Follow `docs/specs/2026-09-01-handoff-claude-history-reconstruction-design.md`.

---

## File Structure

- Modify `extensions/handoff-generation.ts`: classify completion results and propagate loader errors.
- Modify `tests/extensions/handoff-generation.test.ts`: cover provider errors, truncation, empty output, and loader propagation.
- Modify `extensions/handoff.ts`: reject empty generated prompts before manual or automatic branching.
- Modify `tests/extensions/handoff.test.ts`: prove manual and automatic command behavior.
- Create `nix/packages/pi-claude-bridge-safe-history-reconstruction.patch`: add the bridge helper and wire transcript fallback into `src/index.ts`.
- Create `nix/packages/pi-claude-bridge-history-reconstruction.test.mjs`: behavior regression for a tree rebuild after a signed multi-tool turn.
- Modify `nix/packages/pi-deps.nix`: apply the patch and run the bridge regression during the install check.

The patch adds `src/history-reconstruction.ts` inside the fetched bridge source. This pure module keeps new logic out of the bridge entry module, which already exceeds 2,000 lines.

---

### Task 1: Harden handoff completion and loader error transport

**Files:**
- Modify: `tests/extensions/handoff-generation.test.ts`
- Modify: `extensions/handoff-generation.ts:42-58,73-99`

**Interfaces:**
- Consumes: `ctx.modelRegistry.complete(...)` and its `stopReason`, `content`, and optional `errorMessage` fields.
- Produces: `completeHandoffPrompt(...): Promise<string | null>` with `null` reserved for aborts.
- Produces: `generateHandoffPrompt(...): Promise<string | null>` that rejects generation errors after the loader closes.

- [ ] **Step 1: Add failing completion-result regressions**

Add these tests after the existing abort test in `tests/extensions/handoff-generation.test.ts`. Reuse the current model and user-message shape.

```typescript
const completionUserMessage = {
	role: "user",
	content: [{ type: "text", text: "handoff context" }],
	timestamp: 1,
} as any;

function completionContext(response: Record<string, unknown>) {
	return {
		model: { provider: "custom-bridge", id: "custom-model", api: "custom-stream-api" },
		modelRegistry: {
			async complete() {
				return response;
			},
		},
	} as any;
}

test("throws the provider error message when completion stops with an error", async () => {
	await assert.rejects(
		completeHandoffPrompt(
			completionContext({
				stopReason: "error",
				content: [],
				errorMessage: "Claude session reconstruction failed",
			}),
			completionUserMessage,
			new AbortController().signal,
			"handoff-session",
		),
		/Claude session reconstruction failed/,
	);
});

test("rejects a truncated handoff prompt", async () => {
	await assert.rejects(
		completeHandoffPrompt(
			completionContext({
				stopReason: "length",
				content: [{ type: "text", text: "partial prompt" }],
			}),
			completionUserMessage,
			new AbortController().signal,
			"handoff-session",
		),
		/truncated/i,
	);
});

for (const [name, content] of [
	["no text blocks", []],
	["whitespace-only text", [{ type: "text", text: "  \n" }]],
] as const) {
	test(`rejects successful handoff output with ${name}`, async () => {
		await assert.rejects(
			completeHandoffPrompt(
				completionContext({ stopReason: "stop", content }),
				completionUserMessage,
				new AbortController().signal,
				"handoff-session",
			),
			/empty prompt/i,
		);
	});
}

test("rejects an incomplete nonterminal stop reason", async () => {
	await assert.rejects(
		completeHandoffPrompt(
			completionContext({ stopReason: "toolUse", content: [] }),
			completionUserMessage,
			new AbortController().signal,
			"handoff-session",
		),
		/incomplete/i,
	);
});
```

- [ ] **Step 2: Change the loader regression to require rejection**

Replace `returns null when generation fails inside the loader` with this assertion. Keep the existing fake context, loader, runtime, messages, and goal.

```typescript
test("propagates generation failures after the loader closes", async () => {
	const generation = await import("../../extensions/handoff-generation.ts");
	assert.equal(typeof (generation as any).generateHandoffPrompt, "function");

	// Keep the existing ctx, FakeLoader, and runtime setup. ctx.modelRegistry.complete
	// must throw new Error("provider failed").

	await assert.rejects(
		(generation as any).generateHandoffPrompt(
			{
				ctx,
				messages: [{ role: "user", content: "current task", timestamp: 1 }],
				goal: "continue in a fresh session",
			},
			async () => runtime,
		),
		/provider failed/,
	);
});
```

Do not keep the old `assert.equal(result, null)` assertion. Remove the `console.error` mock if the implementation no longer logs the same error.

- [ ] **Step 3: Run the generation tests and confirm the expected red state**

Run:

```sh
node --test --experimental-strip-types tests/extensions/handoff-generation.test.ts
```

Expected failures:

- The provider error resolves to `""` instead of rejecting.
- The length response returns `"partial prompt"`.
- Empty successful responses resolve.
- The loader error resolves to `null`.

- [ ] **Step 4: Implement terminal result classification**

Replace the response tail in `completeHandoffPrompt` with one explicit switch and one text guard:

```typescript
	switch (response.stopReason) {
		case "aborted":
			return null;
		case "error":
			throw new Error(response.errorMessage || "Handoff generation failed");
		case "length":
			throw new Error("Handoff generation was truncated");
		case "stop":
			break;
		default:
			throw new Error(`Handoff generation was incomplete (${response.stopReason})`);
	}

	const prompt = response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	if (prompt.trim().length === 0) {
		throw new Error("Handoff generation returned an empty prompt");
	}
	return prompt;
```

Keep the original text unchanged after the whitespace check.

- [ ] **Step 5: Carry asynchronous loader errors through a tagged result**

Add this private type near `LoadHandoffGenerationRuntime`:

```typescript
type HandoffGenerationOutcome =
	| { kind: "completed"; value: string | null }
	| { kind: "failed"; error: unknown };
```

Change `generateHandoffPrompt` so that `ctx.ui.custom` returns the tagged result. Throw only after the UI promise resolves:

```typescript
	const outcome = await ctx.ui.custom<HandoffGenerationOutcome>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, "Generating handoff prompt...");
		loader.onAbort = () => done({ kind: "completed", value: null });
		const generate = async () => {
			const userMessage: Message = {
				role: "user",
				content: [{
					type: "text",
					text: `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${goal}`,
				}],
				timestamp: Date.now(),
			};
			return completeHandoffPrompt(ctx, userMessage, loader.signal, uuidv7());
		};
		generate()
			.then((value) => done({ kind: "completed", value }))
			.catch((error) => done({ kind: "failed", error }));
		return loader;
	});
	if (outcome.kind === "failed") {
		throw outcome.error;
	}
	return outcome.value;
```

Do not convert a failure to cancellation. Keep the abort callback as the only `null` path inside the loader.

- [ ] **Step 6: Run the focused generation tests green**

Run:

```sh
node --test --experimental-strip-types tests/extensions/handoff-generation.test.ts
```

Expected: all generation tests pass, including custom-provider routing and abort behavior.

- [ ] **Step 7: Commit Task 1**

```sh
git add extensions/handoff-generation.ts tests/extensions/handoff-generation.test.ts
git commit -m "fix(handoff): preserve generation failures"
```

---

### Task 2: Guard manual and automatic handoffs before editor use

**Files:**
- Modify: `tests/extensions/handoff.test.ts`
- Modify: `extensions/handoff.ts:193-205`

**Interfaces:**
- Consumes: `HandoffDependencies.generatePrompt(...) => Promise<string | null>`.
- Produces: the manual path never calls `ctx.ui.editor` for empty generated output.
- Produces: the automatic path disables retries for empty output or generation errors.

- [ ] **Step 1: Add the manual empty-output regression**

Add this test after the successful manual handoff test:

```typescript
test("manual handoff rejects empty generation before opening the editor", async () => {
	const harness = createHarness({
		generatePrompt: async () => "  \n",
	});
	const command = createCommandContext();

	await harness.commandHandler("continue phase one", command.ctx);

	assert.equal(command.getManualEditorCalls(), 0);
	assert.equal(command.sessionOptions.length, 0);
	assert.equal(command.notices.at(-1)?.level, "error");
	assert.match(command.notices.at(-1)?.message ?? "", /empty prompt/i);
});
```

- [ ] **Step 2: Add the manual provider-error regression**

```typescript
test("manual handoff propagates generation errors without opening the editor", async () => {
	const harness = createHarness({
		generatePrompt: async () => {
			throw new Error("Claude session reconstruction failed");
		},
	});
	const command = createCommandContext();

	await assert.rejects(
		harness.commandHandler("continue phase one", command.ctx),
		/Claude session reconstruction failed/,
	);
	assert.equal(command.getManualEditorCalls(), 0);
	assert.equal(command.sessionOptions.length, 0);
});
```

- [ ] **Step 3: Strengthen the automatic failure matrix**

In the loop over `automaticErrorCases`, keep the existing state-transition assertions. Add these assertions after the first failed attempt:

```typescript
assert.equal(command.getManualEditorCalls(), 0);
assert.equal(command.sessionOptions.length, 0);
assert.deepEqual(command.replacementUserMessages, []);
```

The existing `prompt generation throws` and `prompt generation is empty` scenarios then cover automatic provider-error and empty-output behavior.

- [ ] **Step 4: Run the command tests and confirm the expected red state**

Run:

```sh
node --test --experimental-strip-types tests/extensions/handoff.test.ts
```

Expected: the new manual empty-output test fails because the editor opens once. The manual provider-error test already proves that the existing throw path does not create a session.

- [ ] **Step 5: Move the empty-output guard before the manual or automatic split**

Replace the automatic-only guard with this shared guard:

```typescript
		if (generatedPrompt.trim().length === 0) {
			if (automatic) {
				disableAutomatic(ctx, "Handoff generation returned an empty prompt.");
			} else {
				ctx.ui.notify("Handoff generation returned an empty prompt.", "error");
			}
			return;
		}
```

Keep this block after the `generatedPrompt === null` cancellation block and before `ctx.ui.editor`.

Do not trim or rewrite a nonempty prompt. Do not change edited-prompt behavior.

- [ ] **Step 6: Run both handoff suites green**

Run:

```sh
node --test --experimental-strip-types \
  tests/extensions/handoff-generation.test.ts \
  tests/extensions/handoff.test.ts
```

Expected: all handoff tests pass. The known Node module-type warning can remain.

- [ ] **Step 7: Commit Task 2**

```sh
git add extensions/handoff.ts tests/extensions/handoff.test.ts
git commit -m "fix(handoff): reject empty manual prompts"
```

---

### Task 3: Patch bridge reconstruction with safe transcript fallback

**Files:**
- Create: `nix/packages/pi-claude-bridge-history-reconstruction.test.mjs`
- Create: `nix/packages/pi-claude-bridge-safe-history-reconstruction.patch`
- Modify: `nix/packages/pi-deps.nix:59-92`
- Patched upstream file: `src/history-reconstruction.ts`
- Patched upstream file: `src/index.ts:imports, SyncResult, syncSharedSession, query prompt setup`

**Interfaces:**
- Produces inside the patched package: `planHistoryReconstruction(messages, providerId): HistoryReconstructionPlan`.
- Produces inside the patched package: `prependHistoryTranscript(transcript, promptText, promptBlocks)`.
- Extends bridge `SyncResult` with optional `historyTranscript: string`.
- Preserves existing `sessionId` and `preserveSharedSession` behavior for all non-fallback paths.

- [ ] **Step 1: Write the bridge behavior regression first**

Create `nix/packages/pi-claude-bridge-history-reconstruction.test.mjs`:

```javascript
import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

const modulePath = process.env.BRIDGE_HISTORY_MODULE;
if (!modulePath) {
	throw new Error("BRIDGE_HISTORY_MODULE is required");
}

const {
	planHistoryReconstruction,
	prependHistoryTranscript,
} = await import(pathToFileURL(modulePath).href);

const multiToolThinkingHistory = [
	{ role: "user", content: "Inspect both files" },
	{
		role: "assistant",
		provider: "claude-bridge",
		content: [
			{
				type: "thinking",
				thinking: "private reasoning that must not be replayed",
				thinkingSignature: "signed-thinking-value",
			},
			{ type: "redacted_thinking", data: "redacted-thinking-value" },
			{ type: "toolCall", id: "toolu_first", name: "read", arguments: { path: "a.ts" } },
			{ type: "toolCall", id: "toolu_second", name: "read", arguments: { path: "b.ts" } },
		],
	},
	{
		role: "toolResult",
		toolCallId: "toolu_first",
		toolName: "read",
		content: [{ type: "text", text: "alpha" }],
	},
	{
		role: "toolResult",
		toolCallId: "toolu_second",
		toolName: "read",
		content: [{ type: "text", text: "beta" }],
	},
];

test("tree reconstruction after a multi-tool thinking turn uses plain transcript context", () => {
	const plan = planHistoryReconstruction(multiToolThinkingHistory, "claude-bridge");
	assert.equal(plan.kind, "transcript");
	assert.match(plan.transcript, /Inspect both files/);
	assert.match(plan.transcript, /Tool call: read/);
	assert.match(plan.transcript, /alpha/);
	assert.match(plan.transcript, /beta/);
	assert.doesNotMatch(plan.transcript, /private reasoning/);
	assert.doesNotMatch(plan.transcript, /signed-thinking-value/);
	assert.doesNotMatch(plan.transcript, /redacted-thinking-value/);
	assert.doesNotMatch(plan.transcript, /toolu_first|toolu_second/);
});

test("history without a Claude assistant turn keeps the import path", () => {
	assert.deepEqual(
		planHistoryReconstruction([
			{ role: "user", content: "question" },
			{ role: "assistant", provider: "openai-codex", content: [{ type: "text", text: "answer" }] },
		], "claude-bridge"),
		{ kind: "import" },
	);
});

test("transcript context precedes current image prompt blocks", () => {
	const currentBlocks = [
		{ type: "text", text: "Inspect this image" },
		{ type: "image", data: "base64-data", mimeType: "image/png" },
	];
	const prepared = prependHistoryTranscript("plain transcript", "", currentBlocks);
	assert.equal(prepared.promptText, "");
	assert.deepEqual(prepared.promptBlocks.slice(1), currentBlocks);
	assert.match(prepared.promptBlocks[0].text, /plain transcript/);
	assert.match(prepared.promptBlocks[0].text, /Current request/);
});
```

The fixture models the `/tree` failure boundary: one signed thinking block and two tool calls share one Claude assistant turn.

- [ ] **Step 2: Run the bridge regression red against unpatched 0.7.0**

Resolve the fetched bridge source and pass the planned helper path to the test:

```sh
bridge_src=$(nix eval --impure --raw --expr '
  let
    flake = builtins.getFlake (toString ./.);
    pkgs = flake.inputs.nixpkgs.legacyPackages.x86_64-linux;
    deps = import ./nix/packages/pi-deps.nix { inherit pkgs; };
  in toString deps.piClaudeBridge.src
')
BRIDGE_HISTORY_MODULE="$bridge_src/src/history-reconstruction.ts" \
  node --test --experimental-strip-types \
  nix/packages/pi-claude-bridge-history-reconstruction.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` because bridge `0.7.0` has no reconstruction planner. This failure proves that the new package behavior does not exist before the patch.

- [ ] **Step 3: Add the pure reconstruction module to the package patch**

Create `nix/packages/pi-claude-bridge-safe-history-reconstruction.patch` against the published `0.7.0` source. The patch must add `src/history-reconstruction.ts` with these public types and functions:

```typescript
export type ReconstructionMessage = {
	role?: string;
	provider?: string;
	content?: unknown;
	toolName?: string;
};

export type HistoryReconstructionPlan =
	| { kind: "import" }
	| { kind: "transcript"; transcript: string };

export function planHistoryReconstruction(
	messages: readonly ReconstructionMessage[],
	providerId: string,
): HistoryReconstructionPlan;

export function prependHistoryTranscript(
	transcript: string,
	promptText: string,
	promptBlocks?: Array<Record<string, unknown>> | null,
): {
	promptText: string;
	promptBlocks?: Array<Record<string, unknown>> | null;
};
```

Implement the module with these rules:

```typescript
function contentLines(content: unknown): string[] {
	if (typeof content === "string") return content ? [content] : [];
	if (!Array.isArray(content)) return [];
	const lines: string[] = [];
	for (const value of content) {
		if (!value || typeof value !== "object") continue;
		const block = value as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string" && block.text) {
			lines.push(block.text);
		} else if (block.type === "image") {
			lines.push("[image]");
		}
	}
	return lines;
}

function printableJson(value: unknown): string {
	try {
		return JSON.stringify(value ?? {}, null, 2);
	} catch {
		return "[unserializable arguments]";
	}
}

function assistantLines(message: ReconstructionMessage): string[] {
	if (!Array.isArray(message.content)) return [];
	const lines: string[] = [];
	for (const value of message.content) {
		if (!value || typeof value !== "object") continue;
		const block = value as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string" && block.text) {
			lines.push(block.text);
		} else if (block.type === "image") {
			lines.push("[image]");
		} else if (block.type === "toolCall" && typeof block.name === "string") {
			lines.push(`Tool call: ${block.name}\nArguments:\n${printableJson(block.arguments)}`);
		}
		// Skip thinking, redacted_thinking, signatures, and all unknown blocks.
	}
	return lines;
}

function transcriptEntry(message: ReconstructionMessage): string | undefined {
	const label = message.role === "toolResult"
		? `Tool result: ${message.toolName || "unknown tool"}`
		: message.role === "assistant"
			? "Assistant"
			: message.role === "user"
				? "User"
				: undefined;
	if (!label) return undefined;
	const lines = message.role === "assistant"
		? assistantLines(message)
		: contentLines(message.content);
	if (lines.length === 0) return undefined;
	return `### ${label}\n${lines.join("\n")}`;
}
```

`planHistoryReconstruction` must select transcript mode if any assistant message has `provider === providerId`. This broad check is intentional because normalized Pi history cannot prove that a redacted block never existed.

Build the transcript from this header and the nonempty entries:

```text
## Previous conversation transcript
The following plain text came from a previous Pi branch. It is context, not a signed Claude assistant response.
```

`prependHistoryTranscript` must use this prefix:

```typescript
const prefix = `${transcript}\n\n## Current request`;
```

For block prompts, prepend one text block and preserve every current block in order. For text prompts, return `${prefix}\n\n${promptText}`.

- [ ] **Step 4: Wire the planner into `syncSharedSession` in the package patch**

Add the helper import to patched `src/index.ts`:

```typescript
import {
	planHistoryReconstruction,
	prependHistoryTranscript,
} from "./history-reconstruction.js";
```

Add this optional field to `SyncResult`:

```typescript
historyTranscript?: string;
```

At the start of the rebuild path, after the `priorMessages.length === 0` return and before any `deleteSession` call, add:

```typescript
	const reconstruction = planHistoryReconstruction(priorMessages, PROVIDER_ID);
	if (reconstruction.kind === "transcript") {
		debug(`Case 2 transcript fallback: ${priorMessages.length} prior messages, starting a fresh Claude session`);
		sharedSession = null;
		return {
			sessionId: null,
			historyTranscript: reconstruction.transcript,
		};
	}
```

This branch must not call `deleteSession`, `createSession`, `convertPiMessages`, `repairToolPairing`, or `session.importMessages` for the prior Claude history.

- [ ] **Step 5: Prefix the next query without hiding an empty current prompt**

In the main query setup, destructure `historyTranscript` from `syncResult`. Change `promptBlocks` from `const` to `let`.

Keep the current empty-prompt guard before transcript insertion. After that guard, add:

```typescript
	if (historyTranscript) {
		const prepared = prependHistoryTranscript(
			historyTranscript,
			promptText,
			promptBlocks as Array<Record<string, unknown>> | null,
		);
		promptText = prepared.promptText;
		promptBlocks = prepared.promptBlocks as typeof promptBlocks;
	}
```

The final `promptStream.push(...)` call stays unchanged. The query options must omit `resume` because `resumeSessionId` is `null`.

- [ ] **Step 6: Apply the patch and behavior test in `pi-deps.nix`**

Add these bindings beside `piClaudeBridgePackageLock`:

```nix
piClaudeBridgePatch = ./pi-claude-bridge-safe-history-reconstruction.patch;
piClaudeBridgeHistoryReconstructionTest = ./pi-claude-bridge-history-reconstruction.test.mjs;
```

Update `postPatch`:

```nix
postPatch = ''
  cp ${piClaudeBridgePackageLock} package-lock.json
  patch -p1 < ${piClaudeBridgePatch}
'';
```

Extend the existing `installCheckPhase` after the binary version assertion:

```nix
BRIDGE_HISTORY_MODULE="$out/lib/node_modules/pi-claude-bridge/src/history-reconstruction.ts" \
  ${pkgs.nodejs}/bin/node --test --experimental-strip-types \
  ${piClaudeBridgeHistoryReconstructionTest}
```

Do not change the source URL, source hash, version, npm dependency hash, or package lock.

- [ ] **Step 7: Stage new Nix inputs before the flake build**

```sh
git add \
  nix/packages/pi-claude-bridge-history-reconstruction.test.mjs \
  nix/packages/pi-claude-bridge-safe-history-reconstruction.patch \
  nix/packages/pi-deps.nix
```

This staging step is required because normal Git-backed flake evaluation omits untracked files.

- [ ] **Step 8: Build `pi-config` and run the bridge install check green**

Run:

```sh
nix build .#packages.x86_64-linux.pi-config --no-link
```

Expected: the bridge package applies the patch, the three reconstruction tests pass, and the Claude binary remains `2.1.141 (Claude Code)`.

If the patch fails to apply, regenerate it against the exact `0.7.0` tarball. Do not broaden the patch to unrelated upstream changes.

- [ ] **Step 9: Run the required runtime extension-load check**

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Expected: Pi loads the patched `pi-claude-bridge` extension. No `Failed to load extension`, missing module, or package resolution error appears.

- [ ] **Step 10: Commit Task 3**

```sh
git commit -m "fix(pi): avoid lossy Claude history replay"
```

The files are already staged from Step 7. Inspect `git status --short` before committing and make sure that no unrelated file is staged.

---

### Task 4: Final verification, review, and upstream handoff

**Files:**
- Verify: all files changed in Tasks 1-3.
- Reference: `docs/specs/2026-09-01-handoff-claude-history-reconstruction-design.md`.
- Reference: `docs/plans/2026-09-01-handoff-claude-history-reconstruction.md`.

**Interfaces:**
- Produces: fresh evidence for focused tests, package build, runtime extension loading, and the complete flake.
- Produces: a root-cause-to-fix report and a separate upstream change list.

- [ ] **Step 1: Run focused handoff tests**

```sh
node --test --experimental-strip-types \
  tests/extensions/handoff-generation.test.ts \
  tests/extensions/handoff.test.ts
```

Require zero failed tests.

- [ ] **Step 2: Rebuild the patched package path**

```sh
nix build .#packages.x86_64-linux.pi-config --no-link
```

Require exit status 0. This command also reruns the bridge install check when its inputs changed.

- [ ] **Step 3: Run the runtime extension-load check**

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Require exit status 0 and no extension-load error.

- [ ] **Step 4: Run the full flake check**

```sh
nix flake check --accept-flake-config --print-build-logs
```

Require exit status 0. If an unrelated pre-existing check fails, record the exact check and output. Do not claim a complete pass.

- [ ] **Step 5: Inspect the final change set**

```sh
git diff 2ce18446f77d15fe7a058181f6c43799f424a724...HEAD --check
git diff 2ce18446f77d15fe7a058181f6c43799f424a724...HEAD --stat
git status --short
```

Require no whitespace errors and no unintended files. The worktree must be clean after all commits.

- [ ] **Step 6: Request adversarial review**

Dispatch the canonical Pi `reviewer` with fresh context. Include:

- Base SHA: `2ce18446f77d15fe7a058181f6c43799f424a724`.
- Head SHA: the final branch `HEAD`.
- Requirements: the approved spec and this plan.
- Description: handoff result hardening plus a local bridge transcript-fallback patch.
- Review focus: cancellation/error distinction, empty editor prevention, unsafe signed replay bypass, transcript data exclusions, Nix patch wiring, and regression strength.

Fix all Critical and Important findings. Re-run every affected focused check after each fix.

- [ ] **Step 7: Prepare the final root-cause-to-fix mapping**

Report these mappings with file paths and verification evidence:

1. `stopReason: "error"` plus empty content was flattened to `""` → explicit provider error throw and loader propagation.
2. `stopReason: "length"` returned partial text → explicit truncation rejection.
3. The empty guard ran only for automatic handoff → shared guard before the manual editor.
4. `session_tree` triggered normalized history import → fresh-session plain transcript fallback for prior Claude assistant history.
5. `convertPiMessages` and `cc-session-io` cannot preserve every signed array → no synthetic replay on the unsafe path.

- [ ] **Step 8: List upstream work separately**

The final report must recommend a separate `elidickinson/pi-claude-bridge` change with:

- `src/history-reconstruction.ts` or an equivalent focused module.
- The `syncSharedSession` transcript-fallback branch.
- Prompt prefix integration for text and image prompts.
- A full event-level test that emits `session_tree` after one thinking block and two tool calls in one assistant turn.
- Assertions that the next query omits `resume` and contains no signed thinking or tool IDs.
- A release that lets this repository remove the local Nix patch.

Do not submit or push the upstream change unless the user asks.

---

## Completion Checklist

- [ ] Each new handoff regression was observed red before production edits.
- [ ] The bridge reconstruction regression was observed red before the package patch.
- [ ] Provider errors preserve `errorMessage`.
- [ ] Truncation and empty success are errors, not cancellations.
- [ ] Manual empty output never opens the editor.
- [ ] Automatic empty or failed generation disables retries and submits nothing.
- [ ] Normal Claude resume behavior remains unchanged.
- [ ] Unsafe Claude history rebuild uses plain transcript context.
- [ ] Transcript context contains no thinking, signatures, redacted data, or tool IDs.
- [ ] Focused handoff tests pass.
- [ ] The patched bridge install check passes.
- [ ] The Pi extension-load check passes.
- [ ] The full flake check passes, or the final report names exact residual failures.
- [ ] Adversarial review has no unresolved Critical or Important findings.
