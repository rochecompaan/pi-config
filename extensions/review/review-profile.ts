export const REVIEW_PROFILE_IDS = ["standard", "thermo-nuclear"] as const;

export type ReviewProfileId = (typeof REVIEW_PROFILE_IDS)[number];

export type ReviewProfileOption = {
	id: ReviewProfileId;
	label: string;
	description: string;
};

export type ParsedReviewProfileOption = {
	profile: ReviewProfileId;
	profileSpecified: boolean;
	parts: string[];
	error?: string;
};

export const DEFAULT_REVIEW_PROFILE_ID: ReviewProfileId = "standard";

export const REVIEW_PROFILE_OPTIONS: readonly ReviewProfileOption[] = [
	{
		id: "standard",
		label: "Standard review",
		description: "Default correctness, security, and maintainability review",
	},
	{
		id: "thermo-nuclear",
		label: "Thermo-nuclear code quality review",
		description: "Strict structural maintainability and abstraction review",
	},
] as const;

export function isReviewProfileId(value: string): value is ReviewProfileId {
	return (REVIEW_PROFILE_IDS as readonly string[]).includes(value);
}

export function formatReviewProfileList(): string {
	return REVIEW_PROFILE_IDS.join(", ");
}

function profileError(value: string): string {
	return `Unknown review profile: ${value}. Available profiles: ${formatReviewProfileList()}`;
}

function parseProfileValue(value: string | undefined): { profile: ReviewProfileId; error?: string } {
	if (!value?.trim()) {
		return { profile: DEFAULT_REVIEW_PROFILE_ID, error: "Missing value for --profile" };
	}

	const trimmed = value.trim();
	if (!isReviewProfileId(trimmed)) {
		return { profile: DEFAULT_REVIEW_PROFILE_ID, error: profileError(trimmed) };
	}

	return { profile: trimmed };
}

export function parseReviewProfileOption(parts: string[]): ParsedReviewProfileOption {
	let profile = DEFAULT_REVIEW_PROFILE_ID;
	let profileSpecified = false;
	let error: string | undefined;
	const remainingParts: string[] = [];

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];

		if (part === "--profile") {
			profileSpecified = true;
			const next = parts[i + 1];
			if (!next || next.startsWith("--")) {
				error = "Missing value for --profile";
				continue;
			}

			const parsed = parseProfileValue(next);
			profile = parsed.profile;
			error = parsed.error;
			i += 1;
			continue;
		}

		if (part.startsWith("--profile=")) {
			profileSpecified = true;
			const parsed = parseProfileValue(part.slice("--profile=".length));
			profile = parsed.profile;
			error = parsed.error;
			continue;
		}

		remainingParts.push(part);
	}

	return error
		? { profile, profileSpecified, parts: remainingParts, error }
		: { profile, profileSpecified, parts: remainingParts };
}
