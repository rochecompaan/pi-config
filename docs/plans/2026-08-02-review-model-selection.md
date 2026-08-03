# Review Model Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let every `Empty branch` review choose a review-only model through Pi's existing searchable model selector while leaving `Current session` and loop-fixing reviews unchanged.

**Architecture:** Add a focused review-model module that wraps Pi's exported `ModelSelectorComponent`, adapts the public extension registry to the component's runtime contract, and keeps model choice/switch/restoration behavior pure and tested. Apply the alternate model only after navigating to the review branch; persist the original model identity as active-review restoration metadata; then explicitly restore it after `/end-review` reaches the origin because Pi 0.82.1 tree navigation rebuilds messages but not the active runtime model.

**Tech Stack:** TypeScript, Pi 0.82.1 extension API, `ModelSelectorComponent`, `SettingsManager`, Node's built-in test runner, Nix flake checks.

## Global Constraints

- Reuse Pi's exported `ModelSelectorComponent`; do not implement a flat model list, custom catalog filtering, custom search, or custom model rendering.
- Show model selection for every `Empty branch` review, including direct `/review ...` invocations and empty sessions.
- Do not show model selection for `Current session` or loop-fixing reviews.
- Highlight the current model through Pi's existing selector behavior and avoid a redundant `pi.setModel()` call when it is selected.
- Do not add a `--model` argument or persist a preferred review model.
- Apply an alternate model only after review-branch navigation so Pi records its `model_change` on that branch.
- Pi 0.82.1 `navigateTree()` does not restore the active runtime model; never rely on navigation alone for model restoration.
- Persist only the original model identity in active review state, solely as restoration metadata—not as a preferred future review model.
- After `/end-review` navigation, explicitly restore the original model before clearing review state or performing post-return work.
- If restoration fails, return to the captured review leaf and leave the review active for retry.
- Do not append active review state or send the review prompt when model switching fails.
- Keep the existing `@mariozechner/pi-*` import aliases used by this repository.
- Follow the Testing Value Gate: test reusable selection/switch behavior; verify Pi UI integration through the packaged extension-load check and direct TUI exercise rather than asserting source text or static configuration.

---

## File Structure

- Create `extensions/review/review-model.ts` — wraps Pi's model selector, adapts the public registry, classifies choices, and safely switches/restores models.
- Create `extensions/review/review-model.test.ts` — proves model classification, registry adaptation, existing-selector wiring, switch failures, serialized identities, and restoration behavior.
- Modify `extensions/review/index.ts` — requests a model only for fresh reviews, switches after branch navigation, persists restoration metadata, explicitly restores after return, rolls back on failure, and keeps prompt dispatch guarded.

---

### Task 1: Add the review-model selector and switch boundary

**Files:**
- Create: `extensions/review/review-model.test.ts`
- Create: `extensions/review/review-model.ts`

**Interfaces:**
- Consumes: Pi's existing `ExtensionContext`, `ModelSelectorComponent`, `SettingsManager.inMemory()`, and `ctx.modelRegistry` compatibility facade.
- Produces:
  - `ReviewModelSelection = { kind: "cancelled" } | { kind: "unavailable" } | { kind: "current"; model: Model<any> } | { kind: "alternate"; model: Model<any> }`
  - `SelectedReviewModel = Extract<ReviewModelSelection, { kind: "current" | "alternate" }>`
  - `classifyReviewModelSelection(currentModel, selectedModel): ReviewModelSelection`
  - `pickReviewModel(ctx, loadSelectorModule?): Promise<ReviewModelSelection>`
  - `switchReviewModel(selection, setModel): Promise<{ ok: true } | { ok: false; error: string }>`

- [ ] **Step 1: Write the failing review-model tests**

Create `extensions/review/review-model.test.ts` with:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import {
	classifyReviewModelSelection,
	createReviewModelRuntimeAdapter,
	pickReviewModel,
	switchReviewModel,
} from "./review-model.ts";

const currentModel = { provider: "openai", id: "gpt-5.6-sol" } as any;
const reviewModel = { provider: "anthropic", id: "fable" } as any;

test("classifyReviewModelSelection distinguishes cancellation, current, and alternate models", () => {
	assert.deepEqual(classifyReviewModelSelection(currentModel, undefined), { kind: "cancelled" });

	const sameModel = { provider: "openai", id: "gpt-5.6-sol" } as any;
	assert.deepEqual(classifyReviewModelSelection(currentModel, sameModel), {
		kind: "current",
		model: sameModel,
	});

	assert.deepEqual(classifyReviewModelSelection(currentModel, reviewModel), {
		kind: "alternate",
		model: reviewModel,
	});
});

test("classifyReviewModelSelection treats matching ids on different providers as alternate", () => {
	const otherProvider = { provider: "openrouter", id: "gpt-5.6-sol" } as any;
	assert.deepEqual(classifyReviewModelSelection(currentModel, otherProvider), {
		kind: "alternate",
		model: otherProvider,
	});
});

test("createReviewModelRuntimeAdapter maps Pi's public model registry methods", async () => {
	let refreshCalls = 0;
	const registry = {
		getAvailable: () => [currentModel, reviewModel],
		find: (provider: string, id: string) =>
			provider === reviewModel.provider && id === reviewModel.id ? reviewModel : undefined,
		refresh: async () => {
			refreshCalls += 1;
		},
		getError: () => undefined,
	} as any;

	const runtime = createReviewModelRuntimeAdapter(registry);
	assert.deepEqual(runtime.getAvailableSnapshot(), [currentModel, reviewModel]);
	assert.equal(runtime.getModel("anthropic", "fable"), reviewModel);
	assert.deepEqual(await runtime.refresh({ signal: new AbortController().signal }), {
		aborted: false,
		errors: new Map(),
	});
	assert.equal(refreshCalls, 1);
	assert.equal(runtime.getError(), undefined);
});

test("createReviewModelRuntimeAdapter reports refresh failures", async () => {
	const failure = new Error("catalog unavailable");
	const runtime = createReviewModelRuntimeAdapter({
		getAvailable: () => [currentModel],
		find: () => undefined,
		refresh: async () => {
			throw failure;
		},
		getError: () => "catalog unavailable",
	} as any);

	const result = await runtime.refresh({ signal: new AbortController().signal });
	assert.equal(result.aborted, false);
	assert.equal(result.errors.get("model-registry"), failure);
});

test("createReviewModelRuntimeAdapter skips refresh when already aborted", async () => {
	let refreshCalls = 0;
	const controller = new AbortController();
	controller.abort();
	const runtime = createReviewModelRuntimeAdapter({
		getAvailable: () => [currentModel],
		find: () => undefined,
		refresh: async () => {
			refreshCalls += 1;
		},
		getError: () => undefined,
	} as any);

	assert.deepEqual(await runtime.refresh({ signal: controller.signal }), {
		aborted: true,
		errors: new Map(),
	});
	assert.equal(refreshCalls, 0);
});

test("pickReviewModel reports an empty available-model snapshot", async () => {
	const ctx = {
		hasUI: true,
		model: currentModel,
		modelRegistry: { getAvailable: () => [] },
		ui: {
			custom: async () => {
				throw new Error("custom UI should not open");
			},
		},
	} as any;

	const result = await pickReviewModel(ctx, async () => {
		throw new Error("selector module should not load");
	});
	assert.deepEqual(result, { kind: "unavailable" });
});

test("pickReviewModel reuses Pi's selector with current model and registry", async () => {
	const settingsManager = { source: "in-memory" };
	const registry = {
		getAvailable: () => [currentModel, reviewModel],
		find: () => undefined,
		refresh: async () => {},
		getError: () => undefined,
	};
	let constructorArgs: any[] | undefined;

	class FakeModelSelectorComponent {
		constructor(...args: any[]) {
			constructorArgs = args;
			const onSelect = args[5] as (model: any) => void;
			onSelect(reviewModel);
		}
	}

	const ctx = {
		hasUI: true,
		model: currentModel,
		modelRegistry: registry,
		ui: {
			custom: async (factory: any) => {
				let selected: any;
				factory({}, {}, {}, (value: any) => {
					selected = value;
				});
				return selected;
			},
		},
	} as any;

	const result = await pickReviewModel(ctx, async () => ({
		ModelSelectorComponent: FakeModelSelectorComponent as any,
		SettingsManager: { inMemory: () => settingsManager } as any,
	}));

	assert.deepEqual(result, { kind: "alternate", model: reviewModel });
	assert.ok(constructorArgs);
	assert.equal(constructorArgs[1], currentModel);
	assert.equal(constructorArgs[2], settingsManager);
	assert.notEqual(constructorArgs[3], registry);
	assert.deepEqual(constructorArgs[3].getAvailableSnapshot(), [currentModel, reviewModel]);
	assert.deepEqual(constructorArgs[4], []);
});

test("pickReviewModel maps Pi selector cancellation to cancellation", async () => {
	class CancellingModelSelectorComponent {
		constructor(...args: any[]) {
			const onCancel = args[6] as () => void;
			onCancel();
		}
	}

	const ctx = {
		hasUI: true,
		model: currentModel,
		modelRegistry: { getAvailable: () => [currentModel] },
		ui: {
			custom: async (factory: any) => {
				let selected: any;
				factory({}, {}, {}, (value: any) => {
					selected = value;
				});
				return selected;
			},
		},
	} as any;

	const result = await pickReviewModel(ctx, async () => ({
		ModelSelectorComponent: CancellingModelSelectorComponent as any,
		SettingsManager: { inMemory: () => ({}) } as any,
	}));
	assert.deepEqual(result, { kind: "cancelled" });
});

test("switchReviewModel leaves the current model untouched", async () => {
	let calls = 0;
	const result = await switchReviewModel(
		{ kind: "current", model: currentModel },
		async () => {
			calls += 1;
			return true;
		},
	);

	assert.deepEqual(result, { ok: true });
	assert.equal(calls, 0);
});

test("switchReviewModel applies an alternate model", async () => {
	let selected: any;
	const result = await switchReviewModel(
		{ kind: "alternate", model: reviewModel },
		async (model) => {
			selected = model;
			return true;
		},
	);

	assert.deepEqual(result, { ok: true });
	assert.equal(selected, reviewModel);
});

test("switchReviewModel reports false returns and thrown errors", async () => {
	assert.deepEqual(
		await switchReviewModel({ kind: "alternate", model: reviewModel }, async () => false),
		{
			ok: false,
			error: "Failed to select review model anthropic/fable: Pi could not activate the model",
		},
	);

	assert.deepEqual(
		await switchReviewModel({ kind: "alternate", model: reviewModel }, async () => {
			throw new Error("expired token");
		}),
		{
			ok: false,
			error: "Failed to select review model anthropic/fable: expired token",
		},
	);
});
```

- [ ] **Step 2: Run the new test to verify it fails**

Run:

```sh
node --test extensions/review/review-model.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `extensions/review/review-model.ts`.

- [ ] **Step 3: Implement the minimal review-model module**

Create `extensions/review/review-model.ts` with:

```typescript
import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export type ReviewModelSelection =
	| { kind: "cancelled" }
	| { kind: "unavailable" }
	| { kind: "current"; model: Model<any> }
	| { kind: "alternate"; model: Model<any> };

export type SelectedReviewModel = Extract<ReviewModelSelection, { kind: "current" | "alternate" }>;

type ModelSelectorModule = Pick<
	typeof import("@mariozechner/pi-coding-agent"),
	"ModelSelectorComponent" | "SettingsManager"
>;

export type LoadModelSelectorModule = () => Promise<ModelSelectorModule>;

type ReviewModelRegistry = ExtensionContext["modelRegistry"];

type ModelRuntimeRefreshOptions = {
	signal?: AbortSignal;
};

type ModelRuntimeRefreshResult = {
	aborted: boolean;
	errors: Map<string, unknown>;
};

const loadModelSelectorModule: LoadModelSelectorModule = () => import("@mariozechner/pi-coding-agent");

export function createReviewModelRuntimeAdapter(registry: ReviewModelRegistry) {
	return {
		getAvailableSnapshot: () => registry.getAvailable(),
		getModel: (provider: string, id: string) => registry.find(provider, id),
		refresh: async ({ signal }: ModelRuntimeRefreshOptions = {}): Promise<ModelRuntimeRefreshResult> => {
			if (signal?.aborted) return { aborted: true, errors: new Map() };
			try {
				await registry.refresh();
				return { aborted: signal?.aborted === true, errors: new Map() };
			} catch (error) {
				return {
					aborted: signal?.aborted === true,
					errors: new Map([["model-registry", error]]),
				};
			}
		},
		getError: () => registry.getError(),
	};
}

function modelsMatch(left: Model<any> | undefined, right: Model<any>): boolean {
	return left?.provider === right.provider && left.id === right.id;
}

export function classifyReviewModelSelection(
	currentModel: Model<any> | undefined,
	selectedModel: Model<any> | undefined,
): ReviewModelSelection {
	if (!selectedModel) return { kind: "cancelled" };
	if (modelsMatch(currentModel, selectedModel)) return { kind: "current", model: selectedModel };
	return { kind: "alternate", model: selectedModel };
}

export async function pickReviewModel(
	ctx: ExtensionContext,
	loadSelectorModule: LoadModelSelectorModule = loadModelSelectorModule,
): Promise<ReviewModelSelection> {
	if (!ctx.hasUI) return { kind: "cancelled" };
	if (ctx.modelRegistry.getAvailable().length === 0) return { kind: "unavailable" };

	const { ModelSelectorComponent, SettingsManager } = await loadSelectorModule();
	const settingsManager = SettingsManager.inMemory();
	const modelRuntime = createReviewModelRuntimeAdapter(ctx.modelRegistry);
	const scopedModels: Array<{ model: Model<any>; thinkingLevel: string }> = [];

	const selectedModel = await ctx.ui.custom<Model<any> | undefined>((tui, _theme, _keybindings, done) => {
		const selector = new ModelSelectorComponent(
			tui,
			ctx.model,
			settingsManager,
			modelRuntime as any,
			scopedModels as any,
			(model) => done(model),
			() => done(undefined),
		);
		return selector;
	});

	return classifyReviewModelSelection(ctx.model, selectedModel);
}

export type ReviewModelSwitchResult = { ok: true } | { ok: false; error: string };

export async function switchReviewModel(
	selection: SelectedReviewModel,
	setModel: (model: Model<any>) => Promise<boolean>,
): Promise<ReviewModelSwitchResult> {
	if (selection.kind === "current") return { ok: true };

	const modelName = `${selection.model.provider}/${selection.model.id}`;
	try {
		const switched = await setModel(selection.model);
		if (!switched) {
			return {
				ok: false,
				error: `Failed to select review model ${modelName}: Pi could not activate the model`,
			};
		}
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			error: `Failed to select review model ${modelName}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}
```

This keeps the working `SettingsManager.inMemory()` and empty scoped-model pattern from `extensions/prompt-editor.ts:862-884`, but adapts the public extension registry because Pi 0.82.1's component expects `getAvailableSnapshot()`, `getModel()`, `refresh({ signal })`, and `getError()` rather than the extension facade's `getAvailable()`, `find()`, `refresh()`, and `getError()` names.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run:

```sh
node --test extensions/review/review-model.test.ts
```

Expected: PASS with 11 tests and 0 failures after adding adapter coverage. The existing package-type warning is acceptable and pre-existing.

- [ ] **Step 5: Run all review helper tests**

Run:

```sh
node --test extensions/review/*.test.ts
```

Expected: PASS with 0 failures.

- [ ] **Step 6: Commit the helper boundary**

```sh
git add extensions/review/review-model.ts extensions/review/review-model.test.ts
git commit -m "feat(review): add review model selection helpers"
```

---

### Task 2: Wire model selection into fresh review startup

**Files:**
- Modify: `extensions/review/index.ts:14-27`
- Modify: `extensions/review/index.ts:35-63`
- Modify: `extensions/review/index.ts:1702-1798`
- Modify: `extensions/review/index.ts:2134-2258`
- Test: `extensions/review/review-model.test.ts`

**Interfaces:**
- Consumes:
  - `pickReviewModel(ctx): Promise<ReviewModelSelection>` from Task 1.
  - `switchReviewModel(selection, setModel): Promise<ReviewModelSwitchResult>` from Task 1.
  - `SelectedReviewModel` from Task 1.
- Produces:
  - `executeReview(..., options.modelSelection?)` applies the selected model after fresh-branch navigation.
  - `/review` invokes Pi's selector only when `useFreshSession === true`.
  - Failed switches roll back to `lockedOriginId` without active review state or prompt dispatch.

- [ ] **Step 1: Document the user-visible flow in the extension header**

Add this usage bullet after the existing profile bullets near the top of `extensions/review/index.ts`:

```typescript
 * - Empty branch reviews use Pi's model selector to choose a review-only model
```

This is inline usage documentation for the extension, not a standalone documentation test target.

- [ ] **Step 2: Import the Task 1 interfaces**

Add this import after the existing review helper imports:

```typescript
import {
	pickReviewModel,
	switchReviewModel,
	type SelectedReviewModel,
} from "./review-model.ts";
```

- [ ] **Step 3: Extend `executeReview()` options with the selected model**

Replace the current options parameter with:

```typescript
		options?: {
			includeLocalChanges?: boolean;
			extraInstruction?: string;
			profile?: ReviewProfileId;
			modelSelection?: SelectedReviewModel;
		},
```

- [ ] **Step 4: Apply the model after branch navigation and guard activation**

Inside `executeReview()`, in the `if (useFreshSession)` block, insert the following after the existing `reviewOriginId = lockedOriginId;` line and before `setReviewWidget(ctx, true)`:

```typescript
			if (options?.modelSelection) {
				const switchResult = await switchReviewModel(options.modelSelection, (model) => pi.setModel(model));
				if (!switchResult.ok) {
					let rollbackError: string | undefined;
					try {
						const rollback = await ctx.navigateTree(lockedOriginId, { summarize: false });
						if (rollback.cancelled) {
							rollbackError = "navigation was cancelled";
						}
					} catch (error) {
						rollbackError = error instanceof Error ? error.message : String(error);
					}

					reviewOriginId = undefined;
					setReviewWidget(ctx, false);
					ctx.ui.notify(
						rollbackError
							? `${switchResult.error}. Rollback failed: ${rollbackError}`
							: switchResult.error,
						"error",
					);
					return false;
				}
			}
```

The ordering in the completed block must be:

1. navigate to the fresh review branch;
2. restore `reviewOriginId` after navigation events;
3. switch the selected model;
4. only on success, show the review widget and append active `REVIEW_STATE_TYPE`;
5. build and send the review prompt.

Do not move `pi.appendEntry(REVIEW_STATE_TYPE, ...)` above the switch guard.

- [ ] **Step 5: Request a model only after fresh mode is chosen**

In the `/review` handler, replace the final session-mode block—from the `// Determine if we should use fresh session mode` comment through the `executeReview()` call—with:

```typescript
				// Determine if we should use fresh session mode
				// Check if this is a new session (no messages yet)
				const entries = ctx.sessionManager.getEntries();
				const messageCount = entries.filter((e) => e.type === "message").length;

				// In an empty session, default to fresh review mode so /end-review works consistently.
				let useFreshSession = messageCount === 0;

				if (messageCount > 0) {
					// Existing session - ask user which mode they want
					const choice = await ctx.ui.select("Start review in:", ["Empty branch", "Current session"]);

					if (choice === undefined) {
						if (fromSelector) {
							target = null;
							continue;
						}
						ctx.ui.notify("Review cancelled", "info");
						return;
					}

					useFreshSession = choice === "Empty branch";
				}

				let modelSelection: SelectedReviewModel | undefined;
				if (useFreshSession) {
					const selection = await pickReviewModel(ctx);
					if (selection.kind === "cancelled") {
						ctx.ui.notify("Review cancelled", "info");
						return;
					}
					if (selection.kind === "unavailable") {
						ctx.ui.notify("No models are currently available. Use /login to configure a provider.", "error");
						return;
					}
					modelSelection = selection;
				}

				await executeReview(ctx, target, useFreshSession, {
					extraInstruction,
					profile,
					modelSelection,
				});
				return;
```

This keeps direct invocations and interactive target selection on the same model-selection path. The earlier loop-fixing return remains before this block, so loop mode does not open the model selector.

- [ ] **Step 6: Run all review tests**

Run:

```sh
node --test extensions/review/*.test.ts
```

Expected: PASS with 0 failures.

- [ ] **Step 7: Run the packaged extension-load check**

Run:

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Expected: exit 0 with no `Failed to load extension`, missing export, missing package, or constructor error. This is the required direct verification for the Pi component integration; a source-text assertion would not prove runtime compatibility.

- [ ] **Step 8: Run the full flake check**

Run:

```sh
nix flake check --accept-flake-config --print-build-logs
```

Expected: exit 0.

- [ ] **Step 9: Exercise the TUI workflow directly**

Start Pi with the worktree extension loaded:

```sh
pi -e ./extensions/review/index.ts
```

Verify this exact sequence:

1. Start on the main working model and note its `provider/model` in the footer.
2. Run `/review uncommitted`.
3. Choose `Empty branch`.
4. Confirm Pi's normal searchable model selector opens, the current model is highlighted, and typing part of `fable` or `kimi` filters the bounded list.
5. Select a different model and confirm the review starts with that model shown in the footer.
6. Run `/end-review`, choose `Return only`, and confirm the original branch and main working model return.
7. Repeat through `Empty branch`, cancel the model selector, and confirm no active-review widget appears and no review prompt is sent.
8. Repeat with `Current session` and confirm no model selector opens.

- [ ] **Step 10: Review the final diff and commit the integration**

Run:

```sh
git diff --check
git status --short
git diff -- extensions/review/index.ts extensions/review/review-model.ts extensions/review/review-model.test.ts
```

Expected: no whitespace errors; only the planned review extension files are modified since the Task 1 commit.

Commit:

```sh
git add extensions/review/index.ts
git commit -m "feat(review): select the review branch model"
```

---

### Task 3: Persist and restore the original model explicitly

**Why this correction is required:** Live review discovered that Pi 0.82.1 `AgentSession.navigateTree()` calls `sessionManager.branch(...)` and rebuilds only `agent.state.messages`; it does not assign `agent.state.model`. A reproduced `setModel(main) -> setModel(review) -> navigateTree(origin)` sequence leaves `ctx.model` on the review model. Therefore Task 2's original assumption that `/end-review` naturally restores the branch model is invalid.

**Files:**
- Modify: `extensions/review/review-model.test.ts`
- Modify: `extensions/review/review-model.ts`
- Modify: `extensions/review/index.ts:70-143`
- Modify: `extensions/review/index.ts:1710-1810`
- Modify: `extensions/review/index.ts:2386-2538`

**Interfaces:**
- Produces:
  - `ReviewModelIdentity = { provider: string; modelId: string }`
  - `toReviewModelIdentity(model): ReviewModelIdentity`
  - `restoreReviewModel(identity, currentModel, findModel, setModel): Promise<ReviewModelSwitchResult>`
  - `ReviewSessionState.originModel?: ReviewModelIdentity`
- Consumes:
  - `ctx.modelRegistry.find(provider, modelId)` to resolve persisted identity.
  - `pi.setModel(model)` to append the restoring `model_change` after origin navigation.

- [ ] **Step 1: Write failing original-model restoration tests**

Add `restoreReviewModel` and `toReviewModelIdentity` to the import list in `extensions/review/review-model.test.ts`, then append:

```typescript
test("toReviewModelIdentity stores only serializable model identity", () => {
	assert.deepEqual(toReviewModelIdentity(currentModel), {
		provider: "openai",
		modelId: "gpt-5.6-sol",
	});
});

test("restoreReviewModel is a no-op when the original model is already active", async () => {
	let findCalls = 0;
	let setCalls = 0;
	const result = await restoreReviewModel(
		{ provider: "openai", modelId: "gpt-5.6-sol" },
		currentModel,
		() => {
			findCalls += 1;
			return currentModel;
		},
		async () => {
			setCalls += 1;
			return true;
		},
	);

	assert.deepEqual(result, { ok: true });
	assert.equal(findCalls, 0);
	assert.equal(setCalls, 0);
});

test("restoreReviewModel resolves and activates the original model", async () => {
	let selected: any;
	const result = await restoreReviewModel(
		{ provider: "openai", modelId: "gpt-5.6-sol" },
		reviewModel,
		(provider, modelId) =>
			provider === currentModel.provider && modelId === currentModel.id ? currentModel : undefined,
		async (model) => {
			selected = model;
			return true;
		},
	);

	assert.deepEqual(result, { ok: true });
	assert.equal(selected, currentModel);
});

test("restoreReviewModel reports an original model missing from the registry", async () => {
	assert.deepEqual(
		await restoreReviewModel(
			{ provider: "openai", modelId: "gpt-5.6-sol" },
			reviewModel,
			() => undefined,
			async () => true,
		),
		{
			ok: false,
			error: "Original model openai/gpt-5.6-sol is no longer available",
		},
	);
});

test("restoreReviewModel reports false returns and thrown errors", async () => {
	const identity = { provider: "openai", modelId: "gpt-5.6-sol" };
	const findModel = () => currentModel;

	assert.deepEqual(
		await restoreReviewModel(identity, reviewModel, findModel, async () => false),
		{
			ok: false,
			error: "Failed to restore original model openai/gpt-5.6-sol: Pi could not activate the model",
		},
	);

	assert.deepEqual(
		await restoreReviewModel(identity, reviewModel, findModel, async () => {
			throw new Error("expired token");
		}),
		{
			ok: false,
			error: "Failed to restore original model openai/gpt-5.6-sol: expired token",
		},
	);
});
```

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```sh
node --test extensions/review/review-model.test.ts
```

Expected: FAIL because `restoreReviewModel` and `toReviewModelIdentity` are not exported.

- [ ] **Step 3: Add serializable identity and restoration behavior**

Add this after `ReviewModelSwitchResult` in `extensions/review/review-model.ts`:

```typescript
export type ReviewModelIdentity = {
	provider: string;
	modelId: string;
};

export function toReviewModelIdentity(model: Model<any>): ReviewModelIdentity {
	return { provider: model.provider, modelId: model.id };
}

function modelMatchesIdentity(model: Model<any> | undefined, identity: ReviewModelIdentity): boolean {
	return model?.provider === identity.provider && model.id === identity.modelId;
}

export async function restoreReviewModel(
	identity: ReviewModelIdentity,
	currentModel: Model<any> | undefined,
	findModel: (provider: string, modelId: string) => Model<any> | undefined,
	setModel: (model: Model<any>) => Promise<boolean>,
): Promise<ReviewModelSwitchResult> {
	if (modelMatchesIdentity(currentModel, identity)) return { ok: true };

	const modelName = `${identity.provider}/${identity.modelId}`;
	const model = findModel(identity.provider, identity.modelId);
	if (!model) {
		return { ok: false, error: `Original model ${modelName} is no longer available` };
	}

	try {
		const restored = await setModel(model);
		if (!restored) {
			return {
				ok: false,
				error: `Failed to restore original model ${modelName}: Pi could not activate the model`,
			};
		}
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			error: `Failed to restore original model ${modelName}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}
```

- [ ] **Step 4: Run focused tests to verify GREEN**

Run:

```sh
node --test extensions/review/review-model.test.ts
```

Expected: PASS with 16 tests and 0 failures.

- [ ] **Step 5: Persist and rehydrate original-model restoration metadata**

In `extensions/review/index.ts`, import `restoreReviewModel`, `toReviewModelIdentity`, and `type ReviewModelIdentity` from `review-model.ts`.

Add module state and extend the persisted state type:

```typescript
let reviewOriginId: string | undefined = undefined;
let reviewOriginModel: ReviewModelIdentity | undefined = undefined;

type ReviewSessionState = {
	active: boolean;
	originId?: string;
	originModel?: ReviewModelIdentity;
};
```

In `applyReviewState()`, set `reviewOriginModel = state.originModel` when active and clear it when inactive. In `clearReviewState()`, also clear `reviewOriginModel`.

At the beginning of the fresh-session block in `executeReview()`, derive restoration metadata only for an alternate selection:

```typescript
			const originModel =
				options?.modelSelection?.kind === "alternate" && ctx.model
					? toReviewModelIdentity(ctx.model)
					: undefined;
			if (options?.modelSelection?.kind === "alternate" && !originModel) {
				ctx.ui.notify("Failed to determine the original model before starting review.", "error");
				return false;
			}
```

Keep a locked copy beside `lockedOriginId`, restore both module variables after navigation events, and append active state with restoration metadata:

```typescript
			const lockedOriginModel = originModel;

			reviewOriginId = lockedOriginId;
			reviewOriginModel = lockedOriginModel;

			pi.appendEntry(REVIEW_STATE_TYPE, {
				active: true,
				originId: lockedOriginId,
				...(lockedOriginModel ? { originModel: lockedOriginModel } : {}),
			});
```

Replace the startup switch-failure body with explicit navigation and model restoration:

```typescript
				if (!switchResult.ok) {
					const rollbackFailures: string[] = [];
					try {
						const rollback = await ctx.navigateTree(lockedOriginId, { summarize: false });
						if (rollback.cancelled) rollbackFailures.push("origin navigation was cancelled");
					} catch (error) {
						rollbackFailures.push(`origin navigation failed: ${error instanceof Error ? error.message : String(error)}`);
					}

					if (lockedOriginModel) {
						const restoreResult = await restoreReviewModel(
							lockedOriginModel,
							ctx.model,
							(provider, modelId) => ctx.modelRegistry.find(provider, modelId),
							(model) => pi.setModel(model),
						);
						if (!restoreResult.ok) rollbackFailures.push(restoreResult.error);
					}

					reviewOriginId = undefined;
					reviewOriginModel = undefined;
					setReviewWidget(ctx, false);
					ctx.ui.notify(
						rollbackFailures.length > 0
							? `${switchResult.error}. Rollback problems: ${rollbackFailures.join("; ")}`
							: switchResult.error,
						"error",
					);
					return false;
				}
```

This aggregates switch, navigation, and restoration failures and never activates or sends the review prompt.

- [ ] **Step 6: Restore after every successful `/end-review` navigation**

Before navigating in `executeEndReviewAction()`, capture:

```typescript
		const originModel = reviewOriginModel ?? getReviewState(ctx)?.originModel;
		const reviewLeafId = ctx.sessionManager.getLeafId() ?? undefined;
		if (originModel && !reviewLeafId) {
			ctx.ui.notify("Failed to determine the review branch position for model restoration.", "error");
			return "error";
		}
```

Add a focused nested boundary:

```typescript
	async function restoreOriginModelAfterNavigation(
		ctx: ExtensionCommandContext,
		originId: string,
		originModel: ReviewModelIdentity | undefined,
		reviewLeafId: string | undefined,
	): Promise<boolean> {
		if (!originModel) return true;

		const result = await restoreReviewModel(
			originModel,
			ctx.model,
			(provider, modelId) => ctx.modelRegistry.find(provider, modelId),
			(model) => pi.setModel(model),
		);
		if (result.ok) return true;

		let rollbackError: string | undefined;
		if (reviewLeafId) {
			try {
				const rollback = await ctx.navigateTree(reviewLeafId, { summarize: false });
				if (rollback.cancelled) rollbackError = "navigation was cancelled";
			} catch (error) {
				rollbackError = error instanceof Error ? error.message : String(error);
			}
		}

		reviewOriginId = originId;
		reviewOriginModel = originModel;
		setReviewWidget(ctx, true);
		ctx.ui.notify(
			rollbackError
				? `${result.error}. Failed to return to the review branch: ${rollbackError}`
				: `${result.error}. Returned to the review branch; repair authentication and retry /end-review.`,
			"error",
		);
		return false;
	}
```

After successful `returnOnly` navigation and before `clearReviewState()`, add:

```typescript
			if (!await restoreOriginModelAfterNavigation(ctx, originId, originModel, reviewLeafId)) {
				return "error";
			}
```

After successful summary navigation/cancellation checks and before the `returnAndTodo` branch, add the same guard:

```typescript
		if (!await restoreOriginModelAfterNavigation(ctx, originId, originModel, reviewLeafId)) {
			return "error";
		}
```

Both guards run before `clearReviewState()`, todo creation, success notification, or fix-prompt dispatch. The required ordering is `navigate origin -> restore original model -> clear/continue`.

- [ ] **Step 7: Run all automated and packaged checks**

```sh
node --test extensions/review/*.test.ts
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
```

Expected: all review tests pass, packaged extensions load, and all flake checks pass.

- [ ] **Step 8: Run direct Pi lifecycle verification**

Use an isolated temporary Pi config and a temporary extension that intercepts review prompt dispatch so no API request or user default setting is affected. Verify:

1. main runtime model is `openai-codex/gpt-5.6-sol`;
2. `/review uncommitted` opens Pi's native selector;
3. selecting Kimi K3 changes the runtime model on the review branch;
4. `/end-review` with `Return only` returns to the origin and explicitly restores `openai-codex/gpt-5.6-sol`;
5. cancelling the picker sends no prompt and creates no active review state;
6. forcing restoration failure returns to the review leaf and leaves active state recoverable.

- [ ] **Step 9: Commit the completed integration**

```sh
git add extensions/review/index.ts extensions/review/review-model.ts extensions/review/review-model.test.ts
git commit -m "feat(review): select and restore the review model"
```

---

## Completion Checklist

- [ ] Pi's existing `ModelSelectorComponent` is used; no custom full-list picker exists.
- [ ] Every fresh review path opens the selector before session-tree mutation.
- [ ] Current-session and loop-fixing review behavior is unchanged.
- [ ] Current-model selection does not call `pi.setModel()`.
- [ ] Alternate selection writes its model change only after review-branch navigation.
- [ ] Switch failure rolls back and never activates or dispatches the review.
- [ ] Review unit tests pass.
- [ ] Packaged extension-load check passes.
- [ ] Full flake check passes.
- [ ] TUI flow confirms model isolation, cancellation, and restoration.
