import type { AssistantMessage, Context } from "@mariozechner/pi-ai";
import type { ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { QUICKFIX_PROFILE_OPTIONS, type QuickfixProfileId } from "./profiles.ts";

export type QuickfixClassifiedProfile = QuickfixProfileId | "ambiguous";
export type QuickfixClassification = {
	summary: string;
	profile: QuickfixClassifiedProfile;
	confidence: "high" | "low";
};
export type QuickfixClassifierResult =
	| { ok: true; value: QuickfixClassification }
	| { ok: false; error: string };

const RESULT_PATTERN =
	/^(?<summary>[\s\S]*?)\r?\nQUICKFIX_PROFILE:[\t ]*(?<profile>bug|static|docs|mechanical|ambiguous)[\t ]*\r?\nQUICKFIX_CONFIDENCE:[\t ]*(?<confidence>high|low)[\t ]*(?:\r?\n)*$/;

const QUICKFIX_SUMMARY_POLICY = `Include only:
- the current goal
- confirmed behavior and evidence
- relevant files and symbols
- constraints and user decisions
- unresolved details that affect the fix

Exclude sibling branches, old orchestration messages, and unrelated tool output.`;

export const QUICKFIX_CLASSIFIER_SYSTEM_PROMPT = `You classify bounded quick-fix requests and write concise handoff summaries.
${QUICKFIX_SUMMARY_POLICY}
Return only a factual summary followed by the required markers. Do not use tools or make changes.`;

function textContent(content: AssistantMessage["content"] | readonly unknown[]): string {
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" &&
				block !== null &&
				"type" in block &&
				block.type === "text" &&
				"text" in block &&
				typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function appendVisibleMessage(
	sections: string[],
	message: { role: string; content?: string | readonly unknown[] },
): void {
	if (message.role === "user") {
		const text = typeof message.content === "string" ? message.content.trim() : textContent(message.content ?? []);
		if (text) sections.push(`USER: ${text}`);
	}
	if (message.role === "assistant") {
		const text = textContent(Array.isArray(message.content) ? message.content : []);
		if (text) sections.push(`ASSISTANT: ${text}`);
	}
}

function hasClassifierMarker(value: string): boolean {
	return /^\s*QUICKFIX_(?:PROFILE|CONFIDENCE):/m.test(value);
}

export function parseQuickfixClassifierOutput(output: string): QuickfixClassifierResult {
	const match = RESULT_PATTERN.exec(output);
	if (!match?.groups) {
		return { ok: false, error: "Invalid quick-fix classifier markers" };
	}

	const summary = match.groups.summary.trim();
	if (!summary) {
		return { ok: false, error: "Quick-fix classifier summary is empty" };
	}
	if (hasClassifierMarker(summary)) {
		return { ok: false, error: "Duplicate quick-fix classifier markers" };
	}

	return {
		ok: true,
		value: {
			summary,
			profile: match.groups.profile as QuickfixClassifiedProfile,
			confidence: match.groups.confidence as QuickfixClassification["confidence"],
		},
	};
}

export function serializeQuickfixBranch(entries: readonly SessionEntry[]): string {
	const sections: string[] = [];
	for (const entry of entries) {
		if (entry.type === "message") {
			appendVisibleMessage(sections, entry.message);
		}
		if (entry.type === "compaction" && entry.summary.trim()) {
			sections.push(`COMPACTION SUMMARY: ${entry.summary.trim()}`);
			for (const message of entry.retainedTail ?? []) {
				appendVisibleMessage(sections, message);
			}
		}
		if (entry.type === "branch_summary" && entry.summary.trim()) {
			sections.push(`BRANCH SUMMARY: ${entry.summary.trim()}`);
		}
	}
	return sections.join("\n\n");
}

export function buildQuickfixClassifierPrompt(request: string, originContext: string): string {
	const profiles = QUICKFIX_PROFILE_OPTIONS.map(
		({ id, description }) => `- ${id}: ${description}`,
	).join("\n");
	return `Create a concise handoff summary for this bounded quick-fix request and select the best profile.

Quick-fix request:
${request}

Resolved active-branch context:
${originContext || "(No origin context available.)"}

Profiles:
${profiles}

Summary policy:
${QUICKFIX_SUMMARY_POLICY}

End your response with exactly these two lines:
QUICKFIX_PROFILE: bug|static|docs|mechanical|ambiguous
QUICKFIX_CONFIDENCE: high|low`;
}

export async function classifyQuickfix(
	ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
	request: string,
	originContext: string,
): Promise<QuickfixClassifierResult> {
	const model = ctx.model;
	if (!model) return { ok: false, error: "No active model for quick-fix classification" };

	const context: Context = {
		systemPrompt: QUICKFIX_CLASSIFIER_SYSTEM_PROMPT,
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: buildQuickfixClassifierPrompt(request, originContext) }],
				timestamp: Date.now(),
			},
		],
		tools: [],
	};

	try {
		const response = await ctx.modelRegistry.complete(model, context);
		if (response.stopReason === "aborted" || response.stopReason === "error") {
			return { ok: false, error: `Quick-fix classification ${response.stopReason}` };
		}
		const output = textContent(response.content);
		if (!output) return { ok: false, error: "Quick-fix classifier returned no text" };
		return parseQuickfixClassifierOutput(output);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `Quick-fix classification failed: ${message}` };
	}
}
