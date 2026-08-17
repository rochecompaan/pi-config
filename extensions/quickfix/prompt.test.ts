import assert from "node:assert/strict";
import test from "node:test";
import type { Skill } from "@mariozechner/pi-coding-agent";
import {
	buildQuickfixInitialPrompt,
	filterQuickfixSystemPrompt,
} from "./prompt.ts";
import { getQuickfixProfile, QUICKFIX_PROFILE_OPTIONS } from "./profiles.ts";

function skill(name: string): Skill {
	return {
		name,
		description: `${name} instructions`,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		source: "test",
		disableModelInvocation: false,
	};
}

function testFormatSkillsForPrompt(skills: Skill[]): string {
	return `<available_skills>\n${skills.map((item) => `<skill>${item.name}</skill>`).join("\n")}\n</available_skills>`;
}

const usingSuperpowers = skill("using-superpowers");
const brainstorming = skill("brainstorming");
const writingPlans = skill("writing-plans");
const debugging = skill("systematic-debugging");
const tdd = skill("test-driven-development");
const verification = skill("verification-before-completion");
const moduleSize = skill("module-size");
const nixConfig = skill("nix-config");
const simpleEnglish = skill("simple-english");
const allSkills = [
	usingSuperpowers,
	brainstorming,
	writingPlans,
	debugging,
	tdd,
	verification,
	moduleSize,
	nixConfig,
	simpleEnglish,
];
const normalAppend = "[roche-pi skillset: superpowers]\nNormal workflow routing";

function promptWith(skills: Skill[] = allSkills, appendSystemPrompt?: string): string {
	return [
		"Pi base prompt and tool guidance",
		"Project context: obey AGENTS.md",
		appendSystemPrompt,
		testFormatSkillsForPrompt(skills),
	]
		.filter((section): section is string => section !== undefined && section !== "")
		.join("\n\n");
}

function filter(systemPrompt = promptWith(allSkills, normalAppend), skills = allSkills, appendSystemPrompt: string | undefined = normalAppend) {
	return filterQuickfixSystemPrompt({
		formatSkillsForPrompt: testFormatSkillsForPrompt,
		systemPrompt,
		options: {
			cwd: "/repo",
			contextFiles: [{ path: "/repo/AGENTS.md", content: "Project instructions" }],
			appendSystemPrompt,
			skills,
			selectedTools: ["read", "bash", "edit", "write"],
		},
		profile: getQuickfixProfile("bug"),
	});
}

test("keeps Pi and project context while replacing workflow and skills", () => {
	const result = filter();

	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.match(result.systemPrompt, /Pi base prompt and tool guidance/);
	assert.match(result.systemPrompt, /Project context: obey AGENTS\.md/);
	assert.doesNotMatch(result.systemPrompt, /Normal workflow routing/);
	assert.doesNotMatch(result.systemPrompt, /using-superpowers|brainstorming|writing-plans/);
	assert.match(result.systemPrompt, /systematic-debugging/);
	assert.match(result.systemPrompt, /test-driven-development/);
	assert.match(result.systemPrompt, /verification-before-completion/);
	assert.match(result.systemPrompt, /module-size/);
	assert.match(result.systemPrompt, /NEEDS_NORMAL_WORKFLOW/);
});

test("uses every profile's exact selected skills", () => {
	for (const profile of QUICKFIX_PROFILE_OPTIONS) {
		const result = filterQuickfixSystemPrompt({
			formatSkillsForPrompt: testFormatSkillsForPrompt,
			systemPrompt: promptWith(allSkills, normalAppend),
			options: { appendSystemPrompt: normalAppend, skills: allSkills },
			profile,
		});

		assert.equal(result.ok, true, profile.id);
		if (!result.ok) continue;
		assert.match(result.systemPrompt, new RegExp(testFormatSkillsForPrompt(profile.skills.map((name) => skill(name)))));
		for (const excluded of allSkills.filter((item) => !profile.skills.includes(item.name))) {
			assert.doesNotMatch(result.systemPrompt, new RegExp(`<skill>${excluded.name}</skill>`), profile.id);
		}
	}
});

test("reports missing required skills", () => {
	const result = filter(promptWith(allSkills.filter((item) => item.name !== "module-size")), allSkills.filter((item) => item.name !== "module-size"));
	assert.deepEqual(result, { ok: false, error: "Missing quick-fix skills: module-size" });
});

test("reports a missing original skill block", () => {
	const result = filter("Pi base prompt and tool guidance\n\n" + normalAppend);
	assert.deepEqual(result, { ok: false, error: "Missing original quick-fix skill section" });
});

test("reports duplicate original skill blocks", () => {
	const originalSkillText = testFormatSkillsForPrompt(allSkills);
	const result = filter(`${promptWith(allSkills, normalAppend)}\n\n${originalSkillText}`);
	assert.deepEqual(result, { ok: false, error: "Ambiguous original quick-fix skill section" });
});

test("reports a missing normal appended prompt when one is configured", () => {
	const result = filter(promptWith(allSkills, ""));
	assert.deepEqual(result, { ok: false, error: "Missing normal appended prompt" });
});

test("filters successfully with no appended prompt", () => {
	const result = filterQuickfixSystemPrompt({
		formatSkillsForPrompt: testFormatSkillsForPrompt,
		systemPrompt: promptWith(allSkills, undefined),
		options: { skills: allSkills },
		profile: getQuickfixProfile("bug"),
	});
	assert.equal(result.ok, true);
	if (result.ok) assert.match(result.systemPrompt, /NEEDS_NORMAL_WORKFLOW/);
});

test("builds the initial prompt from request, summary, and profile", () => {
	const result = buildQuickfixInitialPrompt({
		request: "Fix empty input parsing",
		summary: "Empty input reaches tokenization.",
		profile: getQuickfixProfile("bug"),
	});

	assert.match(result, /# Quick-fix request\n\nFix empty input parsing/);
	assert.match(result, /# Origin-session summary\n\nEmpty input reaches tokenization\./);
	assert.match(result, /# Active profile\n\nbug: Bug fixes/);
	assert.match(result, /# Quick-fix contract/);
});

test("uses the fallback message when no origin summary is available", () => {
	const result = buildQuickfixInitialPrompt({ request: "Fix empty input parsing", profile: getQuickfixProfile("bug") });
	assert.match(result, /No origin summary is available\. Inspect the repository and ask focused questions when required\./);
});
