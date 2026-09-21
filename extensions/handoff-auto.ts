export const DEFAULT_AUTO_ENABLED = false;
export const DEFAULT_AUTO_THRESHOLD_TOKENS = 150_000;
export const AUTO_HANDOFF_COUNTDOWN_SECONDS = 5;

export type AutoHandoffState = "armed" | "countdown" | "preparing" | "finalizing" | "disabled";

export type ParsedHandoffCommand =
	| { kind: "missing-goal" }
	| { kind: "manual"; goal: string }
	| { kind: "internal-auto" }
	| { kind: "internal-auto-finalize" }
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
	| { type: "session-start"; enabled: boolean }
	| { type: "threshold-reached" }
	| { type: "preparation-started" }
	| { type: "preparation-settled" }
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

function readBooleanSetting(settings: unknown, key: string): boolean | undefined {
	if (!isRecord(settings) || !isRecord(settings.handoff)) return undefined;
	const value = settings.handoff[key];
	return typeof value === "boolean" ? value : undefined;
}

export function resolveAutoEnabled(sources: HandoffSettingsSources): boolean {
	const globalValue = readBooleanSetting(sources.globalSettings, "autoEnabled");
	const projectValue = sources.projectTrusted
		? readBooleanSetting(sources.projectSettings, "autoEnabled")
		: undefined;
	return projectValue ?? globalValue ?? DEFAULT_AUTO_ENABLED;
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
	if (value === "--auto-finalize") return { kind: "internal-auto-finalize" };
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
			return event.enabled ? "armed" : "disabled";
		case "threshold-reached":
			return "countdown";
		case "preparation-started":
			return "preparing";
		case "preparation-settled":
			return "finalizing";
		case "auto-off":
		case "attempt-failed":
			return "disabled";
		case "auto-on":
			return event.usageTokens !== undefined && event.usageTokens >= event.thresholdTokens
				? "countdown"
				: "armed";
	}
}

export default function handoffAutoPolicyExtension(): void {}
