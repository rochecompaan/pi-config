# Branch Review Preset Design

## Goal

Add a `/review` preset that reviews a target branch or ref against a selectable base branch without checking out the target branch. This supports reviewing work completed in another worktree while the current Pi session remains on the main worktree/branch.

## User Interface

- Add a selector preset labeled `Review another branch against base` with a description such as `(no checkout)`.
- Add direct command syntax:
  - `/review compare <target-branch-or-ref>` reviews the target against the repo default branch.
  - `/review compare <target-branch-or-ref> <base-branch-or-ref>` reviews the target against the explicit base.
- In selector mode, prompt for the target branch/ref first, then prompt for the base branch/ref.
- The base prompt should default to the repository default branch (`origin/HEAD`, falling back to `main`/`master`/`main`).

## Review Behavior

Introduce a `compareBranches` review target with `targetBranch` and `baseBranch` fields. Its prompt should instruct the reviewer to compute or use the merge base between the target and base, then inspect the target-side diff without switching branches:

```sh
git diff <merge-base> <target-branch-or-ref>
```

When the extension can compute the merge base up front, the prompt should include the resolved SHA. If the merge base cannot be resolved, the prompt should give fallback commands using `git merge-base <target> <base>`.

## Data Flow

1. Parse direct args or gather target/base via the selector.
2. Build a `compareBranches` target.
3. Build the review prompt using a helper that resolves `git merge-base <target> <base>`.
4. Execute review through the existing session-mode flow (`Empty branch` or `Current session`).
5. Preserve existing shared custom instructions, project review guidelines, and `--extra` handling.

## Error Handling

- If branch lists cannot be loaded, still allow free-form branch/ref entry where practical.
- Do not checkout or switch branches.
- If merge-base resolution fails, do not block the review; provide fallback commands in the prompt.
- Keep existing PR checkout clean-working-tree checks unchanged because this feature does not use checkout.

## Testing

Add focused tests for pure parsing/prompt helpers rather than attempting to test the TUI:

- `/review compare feature` parses to target `feature` and no explicit base.
- `/review compare feature main` parses to target `feature`, base `main`.
- Compare prompt with a resolved merge base uses `git diff <mergeBase> <target>`.
- Compare prompt fallback instructs `git merge-base <target> <base>` and `git diff <mergeBase> <target>`.

If existing `review.ts` internals are not exported, extract narrow pure helpers to a small companion module so tests can import them without loading the whole extension.

## Module Structure

`extensions/review.ts` is already large, so keep the behavior change small inside that file and extract only pure, testable compare parsing/prompt helper code if needed. Avoid broad refactoring unrelated to the new preset.
