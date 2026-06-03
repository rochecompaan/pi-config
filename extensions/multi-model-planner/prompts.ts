export interface PromptResponse {
	label: string;
	content: string;
}

export interface BuildDraftPromptInput {
	task: string;
}

export interface LegacyDiscussionRound1PromptInput {
	recipient: string;
	draftResponses: ReadonlyMap<string, string> | Record<string, string>;
}

export interface LegacyDiscussionRound2PromptInput {
	recipient: string;
	discussionResponses: ReadonlyMap<string, string> | Record<string, string>;
}

export interface BuildDiscussionRoundPromptInput {
	responses: ReadonlyArray<PromptResponse>;
}

export interface BuildSynthesisPromptInput {
	task: string;
	draftResponses: ReadonlyArray<PromptResponse> | ReadonlyMap<string, string> | Record<string, string>;
	discussionRounds: ReadonlyArray<{
		round: 1 | 2;
		responses: ReadonlyArray<PromptResponse> | ReadonlyMap<string, string> | Record<string, string>;
	}>;
}

export function buildDraftPrompt(input: BuildDraftPromptInput): string {
	return [
		"## Original Task",
		"",
		input.task.trim(),
		"",
		"Produce the strongest draft response you can for this task.",
		"Work independently at this stage. Do not assume access to peer responses.",
	].join("\n");
}

export function buildDiscussionRound1Prompt(
	input: BuildDiscussionRoundPromptInput | LegacyDiscussionRound1PromptInput,
): string {
	const responses = normalizeDiscussionResponses(input, "draftResponses");

	return [
		"The other team members have produced their drafts. Review them and respond:",
		"",
		...buildReadConfirmation("draft responses", responses),
		...buildDiscussionBullets([
			"What do you agree with? What is strong in their approach?",
			"What do you disagree with? Where is their reasoning weak?",
			"What did they catch that you missed in your own draft?",
			"What key points from your draft should be preserved?",
		]),
		...formatPeerSections(responses),
	].join("\n");
}

export function buildDiscussionRound2Prompt(
	input: BuildDiscussionRoundPromptInput | LegacyDiscussionRound2PromptInput,
): string {
	const responses = normalizeDiscussionResponses(input, "discussionResponses");

	return [
		"Round 2 of discussion. Your teammates have responded. Continue the debate:",
		"",
		...buildReadConfirmation("Round 1 responses", responses),
		...buildDiscussionBullets([
			"Where has the team converged? What is settled?",
			"Where do you still disagree? Make your strongest case.",
			"Have any new insights emerged from the discussion?",
			"What is your updated position given everything you have heard?",
		]),
		...formatPeerSections(responses),
	].join("\n");
}

export function buildSynthesisPrompt(input: BuildSynthesisPromptInput): string {
	const draftResponses = normalizeNamedResponses(input.draftResponses);
	const normalizedRounds = input.discussionRounds.map((round) => ({
		round: round.round,
		responses: normalizeNamedResponses(round.responses),
	}));
	const roundSections = normalizedRounds
		.map((round) => formatDiscussionRound(round.round, round.responses))
		.filter(Boolean) as string[];
	const confirmationLines = normalizedRounds.flatMap((round) =>
		buildReadConfirmation(`Round ${round.round} responses`, round.responses),
	);

	return [
		"## Original Task",
		"",
		input.task.trim(),
		"",
		...buildReadConfirmation("draft responses", draftResponses),
		...confirmationLines,
		"## Initial Drafts",
		"",
		...(draftResponses.length > 0 ? formatNamedSections(draftResponses) : ["No successful drafts were available."]),
		"",
		"## Team Discussion",
		"",
		...(roundSections.length > 0 ? interleaveBlankLines(roundSections) : ["No successful discussion outputs were available."]),
		"",
		"## Your Job",
		"",
		"Synthesize the drafts and discussion into the single best version.",
		"Commit to decisions. Resolve disagreements. Fill gaps and remove contradictions.",
	].join("\n");
}

function buildDiscussionBullets(items: readonly string[]): string[] {
	return [
		...items.map((item) => `- ${item}`),
		"",
		"Be direct and specific. This is a technical debate, not a politeness exercise.",
	];
}

function buildReadConfirmation(subject: string, responses: ReadonlyArray<PromptResponse>): string[] {
	if (responses.length === 0) {
		return [];
	}
	return [
		`In your response, explicitly confirm that you read the ${subject} from: ${responses.map((response) => response.label).join(", ")}.`,
		"",
	];
}

function formatDiscussionRound(round: 1 | 2, responses: ReadonlyArray<PromptResponse>): string | null {
	if (responses.length === 0) return null;

	return [
		`### Round ${round}`,
		"",
		...responses.map(({ label, content }) => `**${label}:** ${content}`),
	].join("\n");
}

function formatPeerSections(entries: ReadonlyArray<PromptResponse>): string[] {
	if (entries.length === 0) {
		return [];
	}

	const blocks: string[] = [];
	for (const [index, entry] of entries.entries()) {
		blocks.push("", "---", "", `### ${entry.label}`, "", entry.content);
		if (index < entries.length - 1) {
			blocks.push("");
		}
	}
	return blocks;
}

function formatNamedSections(entries: ReadonlyArray<PromptResponse>): string[] {
	const blocks: string[] = [];
	for (const [index, entry] of entries.entries()) {
		blocks.push(`### ${entry.label}`, "", entry.content);
		if (index < entries.length - 1) {
			blocks.push("");
		}
	}
	return blocks;
}

function interleaveBlankLines(blocks: string[]): string[] {
	return blocks.flatMap((block, index) => (index === 0 ? [block] : ["", block]));
}

function normalizeDiscussionResponses(
	input: BuildDiscussionRoundPromptInput | LegacyDiscussionRound1PromptInput | LegacyDiscussionRound2PromptInput,
	legacyField: "draftResponses" | "discussionResponses",
): PromptResponse[] {
	if ("responses" in input) {
		return normalizeNamedResponses(input.responses);
	}

	const entries = toEntryList(input[legacyField]);
	return entries
		.filter(([label]) => label !== input.recipient)
		.map(([label, content]) => ({ label, content }))
		.filter((entry) => entry.content.trim().length > 0);
}

function normalizeNamedResponses(
	responses: ReadonlyArray<PromptResponse> | ReadonlyMap<string, string> | Record<string, string>,
): PromptResponse[] {
	if (Array.isArray(responses)) {
		return responses
			.map((response) => ({ label: response.label, content: response.content }))
			.filter((response) => response.label.trim() && response.content.trim());
	}

	return toEntryList(responses)
		.map(([label, content]) => ({ label, content }))
		.filter((response) => response.label.trim() && response.content.trim());
}

function toEntryList(value: ReadonlyMap<string, string> | Record<string, string>): Array<[string, string]> {
	if (value instanceof Map) {
		return [...value.entries()];
	}
	return Object.entries(value);
}
