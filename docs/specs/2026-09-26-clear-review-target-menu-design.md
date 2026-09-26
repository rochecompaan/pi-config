# Clear Review Target Menu Design

## Summary

The review target menu mixes review targets with persistent features. Its branch labels also hide the difference between the current branch and another branch.

This change makes the menu target-first. It also removes unused review guidance and automatic loop fixing.

## Goals

- Make each review target clear before the user selects it.
- Distinguish the current branch from another branch or Git ref.
- Keep the existing smart default and stable target order.
- Remove loop fixing and all optional review guidance features.
- Keep the one-time `Return and fix findings` action.

## Non-goals

- Do not change review profiles.
- Do not change review model selection.
- Do not change target-specific review prompts.
- Do not change branch, commit, pull request, or path selection behavior.
- Do not rewrite historical plans or specifications.

## Review Target Menu

The menu heading will be:

> What do you want to review?

The menu will use this fixed order and exact text:

1. **Uncommitted changes** — Staged, unstaged, and untracked files
2. **Current branch** — Compare the checked-out branch with a base branch
3. **Another branch or ref** — Compare it with a base branch without checking it out
4. **Commit** — Changes introduced by one commit
5. **GitHub pull request** — Check out and review a PR
6. **Files or folders** — Review current contents, not Git changes

The smart default will remain selected. The smart default will not change the item order.

The menu will not use parenthetical notes such as `(local)` or `(snapshot, not diff)`.

## Target Behavior

`Uncommitted changes` reviews staged, unstaged, and untracked files.

`Current branch` compares the checked-out branch with a base branch that the user selects.

`Another branch or ref` first asks for the target ref. It then asks for the base ref and does not change the checkout.

`Commit` reviews the changes from one selected commit.

`GitHub pull request` keeps the existing local checkout flow for a selected PR.

`Files or folders` reviews the current contents of one or more paths. It does not produce a Git diff review.

## Removed Features

The implementation will remove these features:

- Automatic loop fixing
- Persistent custom review instructions
- Per-review `--extra` instructions
- Project instructions from `REVIEW_GUIDELINES.md`

The removal includes UI entries, state, persistence, argument parsing, prompt assembly, help text, and loop-specific messages.

The `/review --extra ...` syntax will become unsupported. The command must report that the option is not supported and must not ignore it.

Existing session entries for loop fixing or custom instructions need no migration. The extension will ignore these entries.

## Preserved Features

The implementation will preserve these features:

- All six review targets
- Review profiles and profile rubrics
- Review model selection and model restoration
- Fresh-session and current-session review modes
- Review summaries and review finding todos
- The one-time `Return and fix findings` action
- Finding verification before the one-time fix action

The one-time fix action is not loop fixing. It completes one verification and fix pass after the user ends a review.

## Implementation Boundaries

Most changes belong in `extensions/review/index.ts`.

The selector will map the six target definitions directly into one `SelectList`. It will not contain a settings loop.

The extension will remove review-settings state and persistence. Session lifecycle handlers will apply only active review-session state.

The review widget will use its normal active-review message. It will not contain loop status variants.

The prompt builder will combine the selected profile rubric with the target prompt. It will not append custom, per-run, or project review guidance.

Loop-only parsing and orchestration code will be removed. Shared code for the one-time verified fix workflow will remain.

Historical documents will remain unchanged because they describe earlier designs. Current source comments and command help will match the new behavior.

## Error Handling

Existing errors for missing branches, invalid refs, failed PR checkouts, and cancelled selections will remain unchanged.

The command will reject `--extra` as an unsupported option. It will not treat the option text as a review target.

Old settings entries will not cause an error. The extension will ignore them.

## Testing and Verification

Automated tests will cover behavior that can regress:

- Removed argument support does not add extra instructions.
- Review profile parsing continues to work without `--extra` support.
- The one-time verified fix workflow remains available.
- Existing review targets and lifecycle behavior remain correct.

Tests that exist only for deleted loop behavior will be removed. Tests for finding verification and the one-time fix workflow will remain.

Static UI copy does not need a new automated test. A manual smoke test will inspect the menu heading, item order, labels, descriptions, and smart default.

Implementation verification will include:

```sh
node --test --experimental-strip-types extensions/review/*.test.ts
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
git diff --check
```

## Acceptance Criteria

- `/review` shows only the six review targets.
- The menu uses the approved heading, labels, descriptions, and order.
- The smart default remains selected without reordering the menu.
- The current-branch and other-branch flows remain distinct.
- Loop fixing no longer exists in code or UI.
- Persistent custom instructions no longer exist in code or UI.
- `--extra` and `REVIEW_GUIDELINES.md` no longer affect review prompts.
- The one-time `Return and fix findings` action still works.
- The automated and direct verification steps pass.
