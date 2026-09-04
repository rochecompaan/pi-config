import test from "node:test";
import assert from "node:assert/strict";
import {
	classifyReviewModelSelection,
	createReviewModelRuntimeAdapter,
	pickReviewModel,
	restoreReviewModel,
	switchReviewModel,
	toReviewModelIdentity,
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

test("pickReviewModel passes Pi's model runtime in the current selector position", async () => {
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
			const modelRuntime = args[2];
			const onSelect = args[4] as (model: any) => void;
			const availableModels = modelRuntime.getAvailableSnapshot();
			onSelect(availableModels[1]);
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
	}));

	assert.deepEqual(result, { kind: "alternate", model: reviewModel });
	assert.ok(constructorArgs);
	assert.equal(constructorArgs[1], currentModel);
	assert.notEqual(constructorArgs[2], registry);
	assert.deepEqual(constructorArgs[2].getAvailableSnapshot(), [currentModel, reviewModel]);
	assert.deepEqual(constructorArgs[3], []);
});

test("pickReviewModel maps Pi selector cancellation to cancellation", async () => {
	class CancellingModelSelectorComponent {
		constructor(...args: any[]) {
			const onCancel = args[5] as () => void;
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
