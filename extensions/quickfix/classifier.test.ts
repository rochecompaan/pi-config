import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import {
	buildQuickfixClassifierPrompt,
	classifyQuickfix,
	parseQuickfixClassifierOutput,
	serializeQuickfixBranch,
} from "./classifier.ts";

test("parses a high-confidence profile and removes markers from the summary", () => {
	assert.deepEqual(
		parseQuickfixClassifierOutput(
			"The parser crashes after tokenization.\n\nQUICKFIX_PROFILE: bug\nQUICKFIX_CONFIDENCE: high",
		),
		{
			ok: true,
			value: {
				summary: "The parser crashes after tokenization.",
				profile: "bug",
				confidence: "high",
			},
		},
	);
});

test("parses every valid quick-fix profile marker", () => {
	for (const profile of ["bug", "static", "docs", "mechanical"] as const) {
		assert.deepEqual(
			parseQuickfixClassifierOutput(`Summary for ${profile}.\nQUICKFIX_PROFILE: ${profile}\nQUICKFIX_CONFIDENCE: high`),
			{
				ok: true,
				value: { summary: `Summary for ${profile}.`, profile, confidence: "high" },
			},
		);
	}
});

test("accepts ambiguous and low-confidence results for selector fallback", () => {
	assert.equal(
		parseQuickfixClassifierOutput(
			"Context.\nQUICKFIX_PROFILE: ambiguous\nQUICKFIX_CONFIDENCE: low",
		).ok,
		true,
	);
});

test("rejects missing, duplicate, and trailing classifier markers", () => {
	for (const output of [
		"Summary only",
		"Summary\nQUICKFIX_PROFILE: bug\nQUICKFIX_PROFILE: docs\nQUICKFIX_CONFIDENCE: high",
		"SummaryQUICKFIX_PROFILE: bug\nQUICKFIX_CONFIDENCE: high",
		"Summary\nQUICKFIX_PROFILE: bug\nQUICKFIX_CONFIDENCE:\nhigh",
		"Summary\nQUICKFIX_PROFILE: bug\nQUICKFIX_CONFIDENCE: high\nextra",
	]) {
		assert.equal(parseQuickfixClassifierOutput(output).ok, false, output);
	}
});

test("classifier prompt contains every fixed profile and the explicit request", () => {
	const prompt = buildQuickfixClassifierPrompt("Fix the parser", "origin context");
	assert.match(prompt, /Fix the parser/);
	assert.match(prompt, /bug/);
	assert.match(prompt, /static/);
	assert.match(prompt, /docs/);
	assert.match(prompt, /mechanical/);
	assert.match(prompt, /current goal/);
	assert.match(prompt, /confirmed behavior and evidence/);
	assert.match(prompt, /relevant files and symbols/);
	assert.match(prompt, /constraints and user decisions/);
	assert.match(prompt, /unresolved details/);
	assert.match(prompt, /sibling branches/);
	assert.match(prompt, /old orchestration messages/);
	assert.match(prompt, /unrelated tool output/);
});

test("serializes only visible active-path messages and summaries", () => {
	const entries = [
		{
			type: "message",
			id: "user",
			parentId: null,
			timestamp: "2026-08-17T00:00:00.000Z",
			message: { role: "user", content: "The parser breaks on empty input." },
		},
		{
			type: "message",
			id: "assistant",
			parentId: "user",
			timestamp: "2026-08-17T00:00:01.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "I reproduced the crash in parseTokens." }],
			},
		},
		{
			type: "compaction",
			id: "compaction",
			parentId: "assistant",
			timestamp: "2026-08-17T00:00:02.000Z",
			summary: "Earlier evidence: the empty-input case reaches tokenization.",
			retainedTail: [
				{ role: "user", content: "Keep the public parser API stable." },
				{
					role: "assistant",
					content: [{ type: "text", text: "Confirmed parseTokens rejects empty input." }],
				},
				{
					role: "toolResult",
					toolCallId: "retained-call",
					toolName: "bash",
					content: [{ type: "text", text: "retained tool output" }],
					isError: false,
				},
			],
			tokensBefore: 42,
		},
		{
			type: "branch_summary",
			id: "branch-summary",
			parentId: "compaction",
			timestamp: "2026-08-17T00:00:03.000Z",
			fromId: "assistant",
			summary: "The active branch confirmed the parser is the relevant component.",
		},
		{
			type: "message",
			id: "tool-result",
			parentId: "branch-summary",
			timestamp: "2026-08-17T00:00:04.000Z",
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "bash",
				content: [{ type: "text", text: "secret tool output" }],
				isError: false,
			},
		},
		{
			type: "custom",
			id: "hidden-custom",
			parentId: "tool-result",
			timestamp: "2026-08-17T00:00:05.000Z",
			customType: "orchestration",
			data: { hidden: true },
		},
	] as SessionEntry[];

	const serialized = serializeQuickfixBranch(entries);
	assert.match(serialized, /USER: The parser breaks on empty input\./);
	assert.match(serialized, /ASSISTANT: I reproduced the crash in parseTokens\./);
	assert.match(
		serialized,
		/COMPACTION SUMMARY: Earlier evidence[\s\S]*USER: Keep the public parser API stable\.[\s\S]*ASSISTANT: Confirmed parseTokens rejects empty input\./,
	);
	assert.match(serialized, /BRANCH SUMMARY: The active branch confirmed/);
	assert.doesNotMatch(serialized, /secret tool output|retained tool output|orchestration/);
});

test("classifies with the active model in one no-tool completion", async () => {
	const calls: Array<{ model: unknown; context: { tools: unknown[]; messages: Array<{ content: Array<{ text: string }> }> } }> = [];
	const model = { provider: "test", id: "classifier" };
	const context = {
		model,
		modelRegistry: {
			complete: async (calledModel: unknown, completionContext: (typeof calls)[number]["context"]) => {
				calls.push({ model: calledModel, context: completionContext });
				return {
					stopReason: "stop",
					content: [
						{ type: "text", text: "Fix the empty-input parser crash.\nQUICKFIX_PROFILE: bug\nQUICKFIX_CONFIDENCE: high" },
					],
				};
			},
		},
	} as Pick<ExtensionContext, "model" | "modelRegistry">;

	assert.deepEqual(await classifyQuickfix(context, "Fix the parser", "USER: empty input crashes"), {
		ok: true,
		value: {
			summary: "Fix the empty-input parser crash.",
			profile: "bug",
			confidence: "high",
		},
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0].model, model);
	assert.deepEqual(calls[0].context.tools, []);
	assert.match(calls[0].context.messages[0].content[0].text, /Fix the parser/);
	assert.match(calls[0].context.messages[0].content[0].text, /USER: empty input crashes/);
});

test("reports missing models, completion errors, aborted responses, and empty text", async () => {
	const failedContext = (complete: () => Promise<unknown>) =>
		({ model: { provider: "test", id: "classifier" }, modelRegistry: { complete } }) as Pick<
			ExtensionContext,
			"model" | "modelRegistry"
		>;

	assert.equal((await classifyQuickfix({ model: undefined, modelRegistry: {} } as Pick<ExtensionContext, "model" | "modelRegistry">, "Fix", "Context")).ok, false);
	assert.equal((await classifyQuickfix(failedContext(async () => { throw new Error("network down"); }), "Fix", "Context")).ok, false);
	assert.equal((await classifyQuickfix(failedContext(async () => ({ stopReason: "aborted", content: [] })), "Fix", "Context")).ok, false);
	assert.equal((await classifyQuickfix(failedContext(async () => ({ stopReason: "stop", content: [{ type: "thinking", thinking: "..." }] })), "Fix", "Context")).ok, false);
});
