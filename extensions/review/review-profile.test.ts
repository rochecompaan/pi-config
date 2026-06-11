import test from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_REVIEW_PROFILE_ID,
	REVIEW_PROFILE_IDS,
	formatReviewProfileList,
	parseReviewProfileOption,
} from "./review-profile.ts";

test("known review profiles are listed in user-facing order", () => {
	assert.deepEqual(REVIEW_PROFILE_IDS, ["standard", "thermo-nuclear"]);
	assert.equal(formatReviewProfileList(), "standard, thermo-nuclear");
});

test("parseReviewProfileOption defaults to standard when no profile is supplied", () => {
	assert.deepEqual(parseReviewProfileOption(["branch", "main"]), {
		profile: DEFAULT_REVIEW_PROFILE_ID,
		profileSpecified: false,
		parts: ["branch", "main"],
	});
});

test("parseReviewProfileOption accepts separated --profile value", () => {
	assert.deepEqual(parseReviewProfileOption(["branch", "main", "--profile", "thermo-nuclear"]), {
		profile: "thermo-nuclear",
		profileSpecified: true,
		parts: ["branch", "main"],
	});
});

test("parseReviewProfileOption accepts equals --profile value", () => {
	assert.deepEqual(parseReviewProfileOption(["--profile=thermo-nuclear", "uncommitted"]), {
		profile: "thermo-nuclear",
		profileSpecified: true,
		parts: ["uncommitted"],
	});
});

test("parseReviewProfileOption preserves --extra args for the existing parser", () => {
	assert.deepEqual(
		parseReviewProfileOption(["branch", "main", "--extra", "focus on API boundaries", "--profile", "thermo-nuclear"]),
		{
			profile: "thermo-nuclear",
			profileSpecified: true,
			parts: ["branch", "main", "--extra", "focus on API boundaries"],
		},
	);
});

test("parseReviewProfileOption rejects unknown profile names", () => {
	assert.deepEqual(parseReviewProfileOption(["--profile", "extreme", "branch", "main"]), {
		profile: DEFAULT_REVIEW_PROFILE_ID,
		profileSpecified: true,
		parts: ["branch", "main"],
		error: "Unknown review profile: extreme. Available profiles: standard, thermo-nuclear",
	});
});

test("parseReviewProfileOption rejects missing separated profile values", () => {
	assert.deepEqual(parseReviewProfileOption(["branch", "main", "--profile"]), {
		profile: DEFAULT_REVIEW_PROFILE_ID,
		profileSpecified: true,
		parts: ["branch", "main"],
		error: "Missing value for --profile",
	});
});

test("parseReviewProfileOption rejects empty equals profile values", () => {
	assert.deepEqual(parseReviewProfileOption(["--profile=", "branch", "main"]), {
		profile: DEFAULT_REVIEW_PROFILE_ID,
		profileSpecified: true,
		parts: ["branch", "main"],
		error: "Missing value for --profile",
	});
});

test("parseReviewProfileOption preserves the first profile parse error", () => {
	assert.deepEqual(parseReviewProfileOption(["--profile", "--profile=thermo-nuclear", "branch", "main"]), {
		profile: DEFAULT_REVIEW_PROFILE_ID,
		profileSpecified: true,
		parts: ["branch", "main"],
		error: "Missing value for --profile",
	});
});

test("parseReviewProfileOption preserves --extra values that look like profile flags", () => {
	assert.deepEqual(parseReviewProfileOption(["--extra", "--profile=thermo-nuclear", "branch", "main"]), {
		profile: DEFAULT_REVIEW_PROFILE_ID,
		profileSpecified: false,
		parts: ["--extra", "--profile=thermo-nuclear", "branch", "main"],
	});
});
