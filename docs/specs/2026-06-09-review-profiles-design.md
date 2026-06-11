# Review Profiles Design

## Goal

Add selectable review profiles to the existing `/review` extension so a user can run the standard review rubric or a stricter thermo-nuclear code-quality rubric through the same target and session flow.

This does not add new review targets, branch/worktree behavior, agents, or subagent execution. The existing target selection and `Empty branch` / `Current session` behavior remain unchanged.

## User Interface

### Direct command syntax

Support `--profile` on any `/review` invocation:

```text
/review --profile thermo-nuclear
/review branch main --profile thermo-nuclear
/review compare feature/mainline main --profile thermo-nuclear
```

Profiles:

- `standard` — current default behavior using `REVIEW_RUBRIC`.
- `thermo-nuclear` — strict maintainability/code-quality review using `THERMO_NUCLEAR_RUBRIC`.

If `--profile` is omitted, use `standard`.

### Interactive flow

When `/review` is invoked without a target, prompt for profile before target selection:

1. Select review profile.
2. Select review target using the existing target selector.
3. Select `Empty branch` or `Current session` using the existing session-mode prompt.

If the user cancels profile selection, cancel the review. Existing target selector options, custom review instructions, loop-fixing toggles, and target-specific prompts remain unchanged.

## Architecture

Add a small profile layer inside `extensions/review/index.ts`:

```ts
type ReviewProfileId = "standard" | "thermo-nuclear";

const REVIEW_PROFILES: Record<ReviewProfileId, { label: string; description: string; rubric: string }> = {
  standard: {
    label: "Standard review",
    description: "Default correctness, security, and maintainability review",
    rubric: REVIEW_RUBRIC,
  },
  "thermo-nuclear": {
    label: "Thermo-nuclear code quality review",
    description: "Strict structural maintainability and abstraction review",
    rubric: THERMO_NUCLEAR_RUBRIC,
  },
};
```

Keep `REVIEW_RUBRIC` and `THERMO_NUCLEAR_RUBRIC` entirely separate constants. Do not compose one from the other and do not load the thermo rubric dynamically from the skill file at review time.

Pass the selected profile through parsing/selector handling into `executeReview(...)`. Prompt construction chooses exactly one rubric:

```ts
const rubric = REVIEW_PROFILES[profile].rubric;
let fullPrompt = `${rubric}\n\n---\n\nPlease perform a code review with the following focus:\n\n${prompt}`;
```

Shared custom review instructions, `--extra`, and project `REVIEW_GUIDELINES.md` content are still appended after the selected rubric and target prompt.

## Data Flow

1. Parse direct args.
   - Extract `--profile <name>` or `--profile=<name>` alongside the existing `--extra` handling.
   - Validate the profile name against the known profile registry.
   - Preserve existing parsing for review target subcommands.
2. If no explicit target was provided, show the profile selector first.
3. Resolve/select the review target using the existing flow.
4. Ask for review session mode using the existing `Empty branch` / `Current session` prompt.
5. Build the target-specific review prompt using existing target logic.
6. Build the final review prompt using the selected profile's rubric.
7. Send the review prompt through the existing `/review` session mechanics.

## Error Handling

- Unknown profile names should produce a clear error such as `Unknown review profile: <name>. Available profiles: standard, thermo-nuclear`.
- Missing `--profile` value should produce `Missing value for --profile`.
- Profile selection cancellation in interactive mode should cancel the review cleanly.
- Existing validation for targets, PR checkout, loop-fixing compatibility, and git repository checks should remain unchanged.

## Testing

Add focused tests for pure parsing/profile helpers where practical:

- Default profile is `standard` when no `--profile` is supplied.
- `--profile thermo-nuclear` parses successfully.
- `--profile=thermo-nuclear` parses successfully.
- Unknown profiles produce a parse error.
- Missing `--profile` value produces a parse error.
- Existing `--extra` parsing still works when combined with `--profile`.

Do not add tests for TUI rendering or static documentation text. Verify interactive wiring by typechecking/existing tests and, if needed, a manual `/review` smoke check.

## Non-Goals

- Do not add new branch/worktree target behavior.
- Do not add agent or subagent selection.
- Do not dynamically invoke or load the `thermo-nuclear-code-quality-review` skill at review time.
- Do not combine the standard and thermo-nuclear rubrics.
- Do not change `/end-review` behavior.
