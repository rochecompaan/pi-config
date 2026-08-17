import type { BuildSystemPromptOptions, Skill } from "@mariozechner/pi-coding-agent";
import type { QuickfixProfile } from "./profiles.ts";

export type FormatSkillsForPrompt = (skills: Skill[]) => string;

export type QuickfixPromptFilterResult =
	| { ok: true; systemPrompt: string }
	| { ok: false; error: string };

export const QUICKFIX_CONTRACT = `Quick-fix mode is for one bounded change only.

- Make one bounded change that fulfills the quick-fix request.
- Do not create a design, specification, implementation plan, or worktree.
- Do not commit automatically.
- Confirm the expected behavior and root cause before editing.
- Use the project Testing Value Gate before adding tests.
- Run focused validation after the change.
- Report changed files, commands, exit codes, evidence, and residual risks.
- Do not start a subagent or multi-model team.
- Remain interactive so the user can refine or discuss the result.

Stop with NEEDS_NORMAL_WORKFLOW when the scope expands to a new product or feature decision, public API or schema change, migration, security-boundary change, architectural change, multiple independent changes, unclear expected behavior, or work that no longer fits the original bounded request.`;

const NO_ORIGIN_SUMMARY = "No origin summary is available. Inspect the repository and ask focused questions when required.";

function findSingleSection(systemPrompt: string, section: string, missing: string, ambiguous: string): QuickfixPromptFilterResult | number {
	const first = systemPrompt.indexOf(section);
	if (first === -1) return { ok: false, error: missing };
	if (systemPrompt.indexOf(section, first + section.length) !== -1) {
		return { ok: false, error: ambiguous };
	}
	return first;
}

function removeLastSection(systemPrompt: string, section: string): QuickfixPromptFilterResult | string {
	const index = systemPrompt.lastIndexOf(section);
	if (index === -1) return { ok: false, error: "Missing normal appended prompt" };
	return systemPrompt.slice(0, index) + systemPrompt.slice(index + section.length);
}

export function buildQuickfixInitialPrompt(input: {
	request: string;
	summary?: string;
	profile: QuickfixProfile;
}): string {
	const summary = input.summary?.trim() || NO_ORIGIN_SUMMARY;
	const profile = `${input.profile.id}: ${input.profile.label}\n${input.profile.description}\nSkills: ${input.profile.skills.join(", ")}`;
	return [
		"# Quick-fix request",
		input.request,
		"# Origin-session summary",
		summary,
		"# Active profile",
		profile,
		"# Quick-fix contract",
		QUICKFIX_CONTRACT,
	].join("\n\n");
}

export function filterQuickfixSystemPrompt(input: {
	systemPrompt: string;
	options: BuildSystemPromptOptions;
	profile: QuickfixProfile;
	formatSkillsForPrompt: FormatSkillsForPrompt;
}): QuickfixPromptFilterResult {
	const available = new Map((input.options.skills ?? []).map((skill) => [skill.name, skill]));
	const missing = input.profile.skills.filter((name) => !available.has(name));
	if (missing.length > 0) {
		return { ok: false, error: `Missing quick-fix skills: ${missing.join(", ")}` };
	}
	const selected = input.profile.skills.map((name) => available.get(name)!);
	const originalSkillSection = input.formatSkillsForPrompt(input.options.skills ?? []);
	const selectedSkillSection = input.formatSkillsForPrompt(selected);
	const skillIndex = findSingleSection(
		input.systemPrompt,
		originalSkillSection,
		"Missing original quick-fix skill section",
		"Ambiguous original quick-fix skill section",
	);
	if (typeof skillIndex !== "number") return skillIndex;

	let filtered =
		input.systemPrompt.slice(0, skillIndex) +
		selectedSkillSection +
		input.systemPrompt.slice(skillIndex + originalSkillSection.length);
	if (input.options.appendSystemPrompt !== undefined) {
		const withoutAppend = removeLastSection(filtered, input.options.appendSystemPrompt);
		if (typeof withoutAppend !== "string") return withoutAppend;
		filtered = withoutAppend;
	}

	return { ok: true, systemPrompt: `${filtered}\n\n${QUICKFIX_CONTRACT}` };
}
