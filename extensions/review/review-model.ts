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
