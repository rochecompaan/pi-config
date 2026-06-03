export type CompareBranchesTarget = {
	targetBranch: string;
	baseBranch?: string;
};

export type CompareBranchesPromptInput = {
	targetBranch: string;
	baseBranch: string;
	mergeBaseSha?: string | null;
};

export function parseCompareBranchArgs(parts: string[]): CompareBranchesTarget | null {
	const targetBranch = parts[0]?.trim();
	if (!targetBranch) return null;

	const baseBranch = parts[1]?.trim() || undefined;
	return baseBranch ? { targetBranch, baseBranch } : { targetBranch };
}

export function buildCompareBranchesPrompt(input: CompareBranchesPromptInput): string {
	const { targetBranch, baseBranch, mergeBaseSha } = input;
	if (mergeBaseSha?.trim()) {
		return `Review the code changes on '${targetBranch}' against the base branch '${baseBranch}'. The merge base commit for this comparison is ${mergeBaseSha.trim()}. Run \`git diff ${mergeBaseSha.trim()} ${targetBranch}\` to inspect the changes on ${targetBranch} without checking it out. Provide prioritized, actionable findings.`;
	}

	return `Review the code changes on '${targetBranch}' against the base branch '${baseBranch}' without checking out ${targetBranch}. Start by finding the merge base with \`git merge-base ${targetBranch} ${baseBranch}\`, then run \`git diff <mergeBaseSha> ${targetBranch}\` to inspect the changes on ${targetBranch}. Provide prioritized, actionable findings.`;
}
