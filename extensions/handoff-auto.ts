export const DEFAULT_AUTO_THRESHOLD_TOKENS = 150_000;
export const AUTO_HANDOFF_COUNTDOWN_SECONDS = 5;
export const AUTO_HANDOFF_GOAL =
	"Continue the current task in a fresh session. Preserve the current objective, decisions, progress, blockers, and concrete next steps.";

export type AutoHandoffState = "armed" | "running" | "disabled";

export type ParsedHandoffCommand =
	| { kind: "missing-goal" }
	| { kind: "manual"; goal: string }
	| { kind: "internal-auto" }
	| { kind: "auto-control"; action: "on" | "off" | "status" };

export type HandoffSettingsSources = {
	globalSettings: unknown;
	projectSettings?: unknown;
	projectTrusted: boolean;
};

export type AutoHandoffTriggerInput = {
	mode: string;
	idle: boolean;
	state: AutoHandoffState;
	usageTokens: number | undefined;
	thresholdTokens: number;
};

export type AutoHandoffEvent =
	| { type: "session-start" }
	| { type: "threshold-reached" }
	| { type: "auto-off" }
	| { type: "attempt-failed" }
	| { type: "auto-on"; usageTokens: number | undefined; thresholdTokens: number };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readThresholdSetting(settings: unknown): { present: boolean; value?: unknown } {
	if (!isRecord(settings) || !isRecord(settings.handoff)) return { present: false };
	if (!Object.prototype.hasOwnProperty.call(settings.handoff, "autoThresholdTokens")) {
		return { present: false };
	}
	return { present: true, value: settings.handoff.autoThresholdTokens };
}

export function resolveAutoThresholdTokens(sources: HandoffSettingsSources): number {
	const globalValue = readThresholdSetting(sources.globalSettings);
	const projectValue = sources.projectTrusted
		? readThresholdSetting(sources.projectSettings)
		: { present: false };
	const effective = projectValue.present ? projectValue : globalValue;
	return effective.present &&
		typeof effective.value === "number" &&
		Number.isFinite(effective.value) &&
		effective.value > 0
		? effective.value
		: DEFAULT_AUTO_THRESHOLD_TOKENS;
}

export function parseHandoffCommand(args: string): ParsedHandoffCommand {
	const value = args.trim();
	if (!value) return { kind: "missing-goal" };
	if (value === "--auto") return { kind: "internal-auto" };
	if (value === "auto on") return { kind: "auto-control", action: "on" };
	if (value === "auto off") return { kind: "auto-control", action: "off" };
	if (value === "auto status") return { kind: "auto-control", action: "status" };
	return { kind: "manual", goal: value };
}

export function shouldTriggerAutoHandoff(input: AutoHandoffTriggerInput): boolean {
	return input.mode === "tui" &&
		input.idle &&
		input.state === "armed" &&
		input.usageTokens !== undefined &&
		input.usageTokens >= input.thresholdTokens;
}

export function transitionAutoHandoffState(_state: AutoHandoffState, event: AutoHandoffEvent): AutoHandoffState {
	switch (event.type) {
		case "session-start":
			return "armed";
		case "threshold-reached":
			return "running";
		case "auto-off":
		case "attempt-failed":
			return "disabled";
		case "auto-on":
			return event.usageTokens !== undefined && event.usageTokens >= event.thresholdTokens
				? "running"
				: "armed";
	}
}

export default function handoffAutoPolicyExtension(): void {}
