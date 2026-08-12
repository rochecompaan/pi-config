import {
	buildAgreedFindingsFixPrompt,
	buildFindingVerificationPrompt,
	parseFindingVerificationReport,
} from "./review-finding-verification.ts";

export type VerifiedFixWorkflowResult = "ok" | "noAgreedFindings" | "cancelled" | "error";

type AssistantSnapshot = {
	id: string;
	text: string;
	stopReason?: string;
};

type NotificationLevel = "info" | "warning" | "error";

const VERIFICATION_READ_ONLY_TOOL_NAMES = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"codegraph_search",
	"codegraph_callers",
	"codegraph_callees",
	"codegraph_impact",
	"codegraph_explore",
	"codegraph_node",
	"codegraph_status",
	"codegraph_files",
	"ctx_search",
	"ctx_stats",
]);

export function getVerificationReadOnlyTools(activeTools: readonly string[]): string[] {
	return activeTools.filter((toolName) => VERIFICATION_READ_ONLY_TOOL_NAMES.has(toolName));
}

export type VerifiedFixWorkflowDependencies = {
	getActiveTools(): string[];
	setActiveTools(toolNames: string[]): void;
	getLastAssistantSnapshot(): AssistantSnapshot | null;
	sendUserMessage(prompt: string): void;
	waitForTurnToStart(previousAssistantId?: string): Promise<boolean>;
	waitForIdle(): Promise<void>;
	notify(message: string, level: NotificationLevel): void;
};

export async function runVerifiedFixWorkflow(
	summaryText: string,
	dependencies: VerifiedFixWorkflowDependencies,
): Promise<VerifiedFixWorkflowResult> {
	let verificationRequest;
	try {
		verificationRequest = buildFindingVerificationPrompt(summaryText);
	} catch (error) {
		dependencies.notify(
			`Review findings could not be verified: ${error instanceof Error ? error.message : String(error)}. No fixes were queued.`,
			"error",
		);
		return "error";
	}

	const originalActiveTools = dependencies.getActiveTools();
	const verificationTools = getVerificationReadOnlyTools(originalActiveTools);
	if (verificationTools.length !== originalActiveTools.length) {
		dependencies.setActiveTools(verificationTools);
	}

	let toolsRestored = false;
	const restoreTools = () => {
		if (toolsRestored) return;
		toolsRestored = true;
		dependencies.setActiveTools(originalActiveTools);
	};

	try {
		const { findings, prompt: verificationPrompt } = verificationRequest;
		dependencies.notify(
			`Verifying ${findings.length} review finding${findings.length === 1 ? "" : "s"} before fixing...`,
			"info",
		);
		const verificationBaselineId = dependencies.getLastAssistantSnapshot()?.id;
		dependencies.sendUserMessage(verificationPrompt);

		if (!(await dependencies.waitForTurnToStart(verificationBaselineId))) {
			dependencies.notify("Finding verification did not start in time; no fixes were queued.", "error");
			return "error";
		}
		await dependencies.waitForIdle();

		const verificationSnapshot = dependencies.getLastAssistantSnapshot();
		if (!verificationSnapshot || verificationSnapshot.id === verificationBaselineId) {
			dependencies.notify("Could not read the finding verification report; no fixes were queued.", "error");
			return "error";
		}
		if (verificationSnapshot.stopReason === "aborted") {
			dependencies.notify("Finding verification was aborted; no fixes were queued.", "warning");
			return "cancelled";
		}
		if (verificationSnapshot.stopReason === "error") {
			dependencies.notify("Finding verification failed; no fixes were queued.", "error");
			return "error";
		}
		if (verificationSnapshot.stopReason === "length") {
			dependencies.notify("Finding verification was truncated; no fixes were queued.", "warning");
			return "error";
		}

		const verification = parseFindingVerificationReport(verificationSnapshot.text, findings);
		if (!verification.ok) {
			dependencies.notify(`${verification.error}; no fixes were queued.`, "error");
			return "error";
		}

		restoreTools();
		const agreedCount = verification.verifications.filter((item) => item.decision === "agree").length;
		const disagreedCount = verification.verifications.length - agreedCount;
		dependencies.notify(
			`Finding verification complete: ${agreedCount} agreed, ${disagreedCount} disagreed.`,
			"info",
		);

		const fixPrompt = buildAgreedFindingsFixPrompt(findings, verification.verifications);
		if (!fixPrompt) {
			dependencies.notify("All review findings were rejected; no fixes were queued.", "info");
			return "noAgreedFindings";
		}

		const fixBaselineId = verificationSnapshot.id;
		dependencies.sendUserMessage(fixPrompt);
		if (!(await dependencies.waitForTurnToStart(fixBaselineId))) {
			dependencies.notify("Verified fix pass did not start in time.", "error");
			return "error";
		}
		await dependencies.waitForIdle();

		const fixSnapshot = dependencies.getLastAssistantSnapshot();
		if (!fixSnapshot || fixSnapshot.id === fixBaselineId) {
			dependencies.notify("Could not read the verified fix result.", "error");
			return "error";
		}
		if (fixSnapshot.stopReason === "aborted") {
			dependencies.notify("Verified fix pass was aborted.", "warning");
			return "cancelled";
		}
		if (fixSnapshot.stopReason === "error" || fixSnapshot.stopReason === "length") {
			dependencies.notify("Verified fix pass did not complete successfully.", "error");
			return "error";
		}

		return "ok";
	} finally {
		restoreTools();
	}
}
