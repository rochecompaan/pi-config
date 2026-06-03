import test from "node:test";
import assert from "node:assert/strict";
import {
	buildDiscussionRound1Prompt,
	buildDiscussionRound2Prompt,
	buildDraftPrompt,
	buildSynthesisPrompt,
} from "../prompts.ts";

test("buildDraftPrompt includes the original task and no peer sections", () => {
	const prompt = buildDraftPrompt({ task: "Plan a Pi extension for multi-model collaboration." });

	assert.match(prompt, /Original Task/i);
	assert.match(prompt, /Plan a Pi extension for multi-model collaboration\./);
	assert.doesNotMatch(prompt, /###\s+codex/i);
	assert.doesNotMatch(prompt, /###\s+gemini/i);
});

test("buildDiscussionRound1Prompt includes only successful peer draft responses excludes self and requires explicit read confirmation", () => {
	const prompt = buildDiscussionRound1Prompt({
		recipient: "claude",
		draftResponses: new Map([
			["claude", "My own draft"],
			["codex", "Codex draft"],
			["gemini", "Gemini draft"],
		]),
	});

	assert.match(prompt, /The other team members have produced their drafts/i);
	assert.match(prompt, /explicitly confirm that you read the draft responses from: codex, gemini\./i);
	assert.match(prompt, /### codex\n\nCodex draft/);
	assert.match(prompt, /### gemini\n\nGemini draft/);
	assert.doesNotMatch(prompt, /### claude/i);
	assert.doesNotMatch(prompt, /My own draft/);
});

test("buildDiscussionRound1Prompt omits failed or empty peer responses", () => {
	const prompt = buildDiscussionRound1Prompt({
		recipient: "claude",
		draftResponses: new Map([
			["claude", "My own draft"],
			["codex", "Codex draft"],
			["gemini", "   "],
			["o3", ""],
		]),
	});

	assert.match(prompt, /### codex\n\nCodex draft/);
	assert.doesNotMatch(prompt, /### gemini/i);
	assert.doesNotMatch(prompt, /### o3/i);
	assert.doesNotMatch(prompt, /failed/i);
	assert.doesNotMatch(prompt, /error/i);
});

test("buildDiscussionRound2Prompt includes only latest successful peer discussion responses excludes self and requires explicit read confirmation", () => {
	const prompt = buildDiscussionRound2Prompt({
		recipient: "codex",
		discussionResponses: new Map([
			["claude", "Claude round 1 reply"],
			["codex", "My round 1 reply"],
			["gemini", "Gemini round 1 reply"],
		]),
	});

	assert.match(prompt, /Round 2 of discussion/i);
	assert.match(prompt, /explicitly confirm that you read the Round 1 responses from: claude, gemini\./i);
	assert.match(prompt, /### claude\n\nClaude round 1 reply/);
	assert.match(prompt, /### gemini\n\nGemini round 1 reply/);
	assert.doesNotMatch(prompt, /### codex/i);
	assert.doesNotMatch(prompt, /My round 1 reply/);
});

test("buildSynthesisPrompt includes original task drafts both discussion rounds and requires explicit read confirmation", () => {
	const prompt = buildSynthesisPrompt({
		task: "Design the run_team tool.",
		draftResponses: new Map([
			["claude", "Claude draft"],
			["codex", "Codex draft"],
		]),
		discussionRounds: [
			{
				round: 1,
				responses: new Map([
					["claude", "Claude round 1"],
					["codex", "Codex round 1"],
				]),
			},
			{
				round: 2,
				responses: new Map([
					["claude", "Claude round 2"],
					["codex", "Codex round 2"],
				]),
			},
		],
	});

	assert.match(prompt, /## Original Task/);
	assert.match(prompt, /Design the run_team tool\./);
	assert.match(prompt, /explicitly confirm that you read the draft responses from: claude, codex\./i);
	assert.match(prompt, /explicitly confirm that you read the Round 1 responses from: claude, codex\./i);
	assert.match(prompt, /explicitly confirm that you read the Round 2 responses from: claude, codex\./i);
	assert.match(prompt, /## Initial Drafts/);
	assert.match(prompt, /### claude\n\nClaude draft/);
	assert.match(prompt, /### codex\n\nCodex draft/);
	assert.match(prompt, /### Round 1/);
	assert.match(prompt, /\*\*claude:\*\* Claude round 1/);
	assert.match(prompt, /\*\*codex:\*\* Codex round 1/);
	assert.match(prompt, /### Round 2/);
	assert.match(prompt, /\*\*claude:\*\* Claude round 2/);
	assert.match(prompt, /\*\*codex:\*\* Codex round 2/);
	assert.match(prompt, /Synthesize the drafts and discussion into the single best version/i);
});

test("buildSynthesisPrompt omits empty draft and discussion entries", () => {
	const prompt = buildSynthesisPrompt({
		task: "Design the run_team tool.",
		draftResponses: new Map([
			["claude", "Claude draft"],
			["gemini", "   "],
		]),
		discussionRounds: [
			{
				round: 1,
				responses: new Map([
					["claude", "Claude round 1"],
					["gemini", ""],
				]),
			},
		],
	});

	assert.match(prompt, /### claude\n\nClaude draft/);
	assert.doesNotMatch(prompt, /### gemini\n\n/);
	assert.match(prompt, /\*\*claude:\*\* Claude round 1/);
	assert.doesNotMatch(prompt, /\*\*gemini:\*\*/);
});
