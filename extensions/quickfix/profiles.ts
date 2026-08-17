export const QUICKFIX_PROFILE_IDS = ["bug", "static", "docs", "mechanical"] as const;
export type QuickfixProfileId = (typeof QUICKFIX_PROFILE_IDS)[number];

export type QuickfixProfile = {
	id: QuickfixProfileId;
	label: string;
	description: string;
	skills: readonly string[];
};

export type ParsedQuickfixCommand = {
	request: string;
	profile?: QuickfixProfileId;
	profileSpecified: boolean;
	error?: string;
};

export const QUICKFIX_BLOCKED_TOOLS: ReadonlySet<string> = new Set(["subagent", "run_team"]);

export const QUICKFIX_PROFILES = {
	bug: {
		id: "bug" as const,
		label: "Bug fixes",
		description: "Focused debugging and corrective work",
		skills: [
			"systematic-debugging",
			"test-driven-development",
			"verification-before-completion",
			"module-size",
		] as const,
	},
	static: {
		id: "static" as const,
		label: "Static improvements",
		description: "Maintenance for static checks and configuration",
		skills: ["verification-before-completion", "nix-config"] as const,
	},
	docs: {
		id: "docs" as const,
		label: "Docs improvements",
		description: "Documentation updates and clarity work",
		skills: ["simple-english", "verification-before-completion"] as const,
	},
	mechanical: {
		id: "mechanical" as const,
		label: "Mechanical cleanup",
		description: "Focused mechanical edits and refactors",
		skills: ["verification-before-completion", "module-size"] as const,
	},
} as const;

export const QUICKFIX_PROFILE_OPTIONS: readonly QuickfixProfile[] = [
	QUICKFIX_PROFILES.bug,
	QUICKFIX_PROFILES.static,
	QUICKFIX_PROFILES.docs,
	QUICKFIX_PROFILES.mechanical,
];

export function isQuickfixProfileId(value: string): value is QuickfixProfileId {
	return (QUICKFIX_PROFILE_IDS as readonly string[]).includes(value);
}

export function getQuickfixProfile(id: QuickfixProfileId): QuickfixProfile {
	const profile = QUICKFIX_PROFILE_OPTIONS.find((item) => item.id === id);
	if (!profile) {
		throw new Error(`Missing quick-fix profile: ${id}`);
	}
	return profile;
}

export function parseQuickfixCommand(raw: string): ParsedQuickfixCommand {
	const value = raw.trim();
	if (!value.startsWith("--profile")) {
		return { request: value, profileSpecified: false };
	}

	const equals = value.match(/^--profile=([^\s]*)(?:\s+([\s\S]*))?$/);
	const separated = value.match(/^--profile(?:\s+([^\s]+))?(?:\s+([\s\S]*))?$/);
	const match = equals ?? separated;
	const profileValue = match?.[1]?.trim();
	const request = match?.[2]?.trim() ?? "";
	if (!profileValue) {
		return { request, profileSpecified: true, error: "Missing value for --profile" };
	}
	if (!isQuickfixProfileId(profileValue)) {
		return {
			request,
			profileSpecified: true,
			error: `Unknown quick-fix profile: ${profileValue}. Available profiles: ${QUICKFIX_PROFILE_IDS.join(", ")}`,
		};
	}
	return { request, profile: profileValue, profileSpecified: true };
}
