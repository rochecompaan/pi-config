import test from "node:test";
import assert from "node:assert/strict";
import { getUnsupportedReviewOptionError } from "./review-command-options.ts";

test("getUnsupportedReviewOptionError rejects both --extra forms", () => {
	assert.equal(getUnsupportedReviewOptionError(["--extra", "focus on security"]), "--extra is no longer supported.");
	assert.equal(getUnsupportedReviewOptionError(["--extra=focus on security"]), "--extra is no longer supported.");
});

test("getUnsupportedReviewOptionError accepts supported review arguments", () => {
	assert.equal(
		getUnsupportedReviewOptionError(["branch", "main", "--profile", "thermo-nuclear"]),
		undefined,
	);
});
