import test from "node:test";
import assert from "node:assert/strict";
import {
	buildCompareBranchesPrompt,
	parseCompareBranchArgs,
} from "./review-compare.ts";

test("parseCompareBranchArgs accepts a target branch without explicit base", () => {
	assert.deepEqual(parseCompareBranchArgs(["feature/worktree-review"]), {
		targetBranch: "feature/worktree-review",
	});
});

test("parseCompareBranchArgs accepts target and base branches", () => {
	assert.deepEqual(parseCompareBranchArgs(["feature/worktree-review", "main"]), {
		targetBranch: "feature/worktree-review",
		baseBranch: "main",
	});
});

test("parseCompareBranchArgs rejects a missing target branch", () => {
	assert.equal(parseCompareBranchArgs([]), null);
});

test("buildCompareBranchesPrompt uses resolved merge base when available", () => {
	const prompt = buildCompareBranchesPrompt({
		targetBranch: "feature/worktree-review",
		baseBranch: "main",
		mergeBaseSha: "abc1234",
	});

	assert.match(prompt, /Review the code changes on 'feature\/worktree-review' against the base branch 'main'/);
	assert.match(prompt, /merge base commit for this comparison is abc1234/);
	assert.match(prompt, /git diff abc1234 feature\/worktree-review/);
	assert.doesNotMatch(prompt, /git merge-base feature\/worktree-review main/);
});

test("buildCompareBranchesPrompt provides fallback commands when merge base is unavailable", () => {
	const prompt = buildCompareBranchesPrompt({
		targetBranch: "feature/worktree-review",
		baseBranch: "main",
	});

	assert.match(prompt, /Review the code changes on 'feature\/worktree-review' against the base branch 'main'/);
	assert.match(prompt, /git merge-base feature\/worktree-review main/);
	assert.match(prompt, /git diff <mergeBaseSha> feature\/worktree-review/);
});
