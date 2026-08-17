# Interactive quick-fix extension design

## Status

Approved in conversation on 2026-08-17.

## Problem

Small fixes can enter the full Superpowers workflow even when the work does not need a design or implementation plan. The workflow adds useful controls for larger changes, but it adds too much overhead to a bounded fix.

A `pi-subagents` worker can load a selected skill list in a fresh child session. However, `/run` does not attach the current Pi TUI to that child. The user cannot continue a normal interactive conversation inside the child.

The user needs a command that behaves like the `Empty branch` mode of `/review`. The command must enter an interactive branch in the current TUI. That branch must expose only the skills that apply to the selected quick-fix profile.

## Goals

- Add `/quickfix <request>` for bounded fixes.
- Enter a new interactive branch in the current Pi TUI.
- Summarize the active origin branch before branch entry.
- Use one model call to create the summary and select a skill profile.
- Show a profile selector when automatic selection is uncertain or unavailable.
- Preserve Pi tool instructions and project context.
- Expose only the skills in the selected profile.
- Remove the normal Superpowers appendix during quick-fix turns.
- Block nested orchestration while quick-fix mode is active.
- Add `/end-quickfix` to return to the origin leaf.
- Preserve the quick-fix branch in the session tree.
- Leave tracked and untracked worktree changes untouched.

## Non-goals

- Replacing the normal Superpowers workflow.
- Creating a separate Pi process or TUI.
- Attaching the TUI to a `pi-subagents` child.
- Creating a design, specification, implementation plan, or worktree for the bounded fix.
- Starting nested subagents or multi-model teams.
- Making automatic commits.
- Checking, stashing, resetting, or cleaning Git changes.
- Converting an expanded task into the normal workflow automatically.
- Supporting quick-fix entry before the current session has an origin leaf.

## User interface

### Start a quick fix

The main command accepts a request:

```text
/quickfix Fix the empty-input parser crash
```

If the command has no request, the extension opens a text input. Cancellation leaves the current session unchanged.

The extension accepts an optional profile override:

```text
/quickfix --profile bug Fix the empty-input parser crash
```

Accepted profile names are:

- `bug`
- `static`
- `docs`
- `mechanical`

An unknown profile shows an error before any model call or branch change.

### Active state

The extension shows a small widget while quick-fix mode is active. The widget contains:

- the active profile.
- the quick-fix label.
- the `/end-quickfix` command.

Follow-up messages remain in the quick-fix branch and use the same filtered prompt.

### End a quick fix

The user ends the mode with:

```text
/end-quickfix
```

The command waits for the active response to settle. It then returns to the saved origin leaf and removes the widget. The quick-fix branch remains available in Pi's session tree.

## Skill profiles

Each profile maps to a fixed skill allowlist. Model output cannot add a skill outside these lists.

| Profile | Skills |
|---|---|
| `bug` | `systematic-debugging`, `test-driven-development`, `verification-before-completion`, `module-size` |
| `static` | `verification-before-completion`, `nix-config` |
| `docs` | `simple-english`, `verification-before-completion` |
| `mechanical` | `verification-before-completion`, `module-size` |

No profile contains these workflow skills:

- `using-superpowers`
- `brainstorming`
- `writing-plans`
- `executing-plans`
- `subagent-driven-development`
- `dispatching-parallel-agents`
- `using-git-worktrees`
- `finishing-a-development-branch`
- `requesting-code-review`
- `receiving-code-review`
- `commit`
- `pi-subagents`

The fixed map is the authority. The classifier selects a profile, not an arbitrary skill list.

## Architecture

The extension uses the current `AgentSession` and its session tree. It does not create or attach a child `AgentSession`.

The extension has five focused parts:

1. A command controller owns `/quickfix` and `/end-quickfix`.
2. A classifier creates the handoff summary and selects a profile.
3. A lifecycle helper owns branch entry, rollback, and return.
4. A prompt filter owns the quick-fix system prompt.
5. A tool gate blocks nested orchestration tools.

The main extension module registers commands and event handlers. It delegates pure parsing, profile, prompt, and state decisions to small modules.

## Classifier and handoff summary

The classifier uses the current session model through the public `ModelRegistry.complete()` API. The call has no tools and does not append messages to the origin branch.

The classifier input contains:

- the explicit quick-fix request.
- the resolved active context from the current branch path.
- the four profile definitions.
- instructions for a concise handoff summary.
- an exact output contract.

The classifier uses Pi's resolved session context. This context obeys existing compaction boundaries and excludes sibling branches.

The output contract ends with these markers:

```text
QUICKFIX_PROFILE: bug|static|docs|mechanical|ambiguous
QUICKFIX_CONFIDENCE: high|low
```

The text before the markers is the handoff summary. The summary contains only facts that help the bounded fix:

- the current goal.
- confirmed behavior and evidence.
- relevant files and symbols.
- constraints and user decisions.
- unresolved details that affect the fix.

The summary excludes sibling branches. It also excludes old orchestration messages and unrelated tool output when the serializer can identify them.

The extension accepts automatic selection only when the profile is valid and confidence is `high`. These results open the profile selector:

- `ambiguous`.
- `low` confidence.
- malformed markers.
- an unavailable model.
- an authentication error.
- an interrupted or failed completion.

If the user supplied `--profile`, the same call creates the handoff summary. The explicit profile remains authoritative.

## Branch entry

The extension records the current leaf before it changes the session tree. This leaf is the return point.

The extension follows the proven `/review` branch pattern. It navigates to the first user message on the active path without Pi branch summarization. The next submitted request creates a sibling branch from that point.

The initial quick-fix message contains:

- the original request.
- the generated handoff summary, if available.
- the selected profile name.
- the bounded quick-fix contract.

The extension labels the branch `quickfix:<profile>`. It activates the `entering` phase before it submits the initial message.

The first `before_agent_start` event records the new user entry as the quick-fix branch marker. The event then filters the initial turn.

If submission fails, the extension keeps filtering active and places the request in the editor.

## Quick-fix state

The active state contains:

- the session identity.
- the origin leaf ID.
- the quick-fix branch marker ID.
- the selected profile.
- the generated summary.
- the original request.
- a lifecycle phase.

The lifecycle phases are:

- `classifying`
- `entering`
- `active`
- `returning`

Only one quick-fix lifecycle can run at one time.

During the `entering` phase, the first submitted user entry becomes the branch marker. During the `active` phase, the extension makes sure that the active path contains this marker.

If the marker is absent during the `active` phase, the extension clears stale state and does not filter the turn.

Session switching, forking, new-session creation, and extension reload clear stale state. Manual tree navigation away from the quick-fix branch also clears the state and widget.

## System-prompt filtering

Pi provides the fully assembled prompt and structured `BuildSystemPromptOptions` in `before_agent_start`.

The extension filters only when the current path contains the active quick-fix marker. It uses the structured options to identify the loaded skills and normal appended prompt.

The filter performs these changes:

1. Preserve the normal Pi base prompt.
2. Preserve selected tool names, tool snippets, and prompt guidelines.
3. Preserve the current working directory.
4. Preserve project context files, including `AGENTS.md`.
5. Remove the normal appended Superpowers prompt.
6. Replace the complete `<available_skills>` block with the selected profile skills.
7. Append the bounded quick-fix contract.

Pi 0.84.2 does not export `buildSystemPrompt()` from its public package entry point. The extension does not import a private module. It replaces the exact appended-prompt text and skill block in the assembled prompt.

The filter resolves every required skill from `event.systemPromptOptions.skills`. If a required skill is absent, branch entry fails before prompt submission.

The filter applies to the initial request and all follow-up turns. The origin branch keeps its normal prompt.

## Quick-fix contract

The quick-fix contract gives these instructions to the model:

- Make one bounded change.
- Do not create a design, specification, implementation plan, or worktree.
- Do not commit automatically.
- Confirm the expected behavior and root cause before editing.
- Use the project Testing Value Gate.
- Run focused validation after the change.
- Report changed files, commands, exit codes, evidence, and residual risks.
- Do not start a subagent or multi-model team.
- Stop with `NEEDS_NORMAL_WORKFLOW` when the scope expands.
- Remain interactive so the user can refine or discuss the result.

The model reports `NEEDS_NORMAL_WORKFLOW` for these cases:

- a new product or feature decision.
- a public API or schema change.
- a migration.
- a security-boundary change.
- an architectural change.
- multiple independent changes.
- unclear expected behavior.
- work that no longer fits the original bounded request.

The extension does not create a specification or plan after this result. The user ends quick-fix mode and continues the normal workflow.

## Tool gate

Removing orchestration skills does not unregister tools from the current Pi process. The extension therefore blocks these tool calls during an active quick-fix turn:

- `subagent`
- `run_team`

The gate returns a clear error that tells the model to complete the bounded fix directly or report `NEEDS_NORMAL_WORKFLOW`.

The extension keeps normal coding, search, time-entry, and project tools available. It does not change the checkout or create another writer.

## Data flow

1. The user enters `/quickfix <request>`.
2. The command validates the mode, request, profile override, and active state.
3. The command records the origin leaf and active branch path.
4. The classifier creates the handoff summary and profile result.
5. The selector opens when the result is uncertain or unavailable.
6. The command resolves every skill in the selected profile.
7. The lifecycle helper navigates to the branch point.
8. The extension records the quick-fix branch marker and activates filtering.
9. The extension submits the request and summary.
10. `before_agent_start` filters the prompt for every quick-fix turn.
11. The tool gate blocks nested orchestration calls.
12. The user continues the conversation in the current TUI.
13. The user enters `/end-quickfix`.
14. The lifecycle helper waits for idle state and returns to the origin leaf.
15. The extension clears active state and the widget.

## Error handling

### Input and validation errors

- A non-TUI invocation reports that `/quickfix` requires interactive mode.
- An empty request opens the input dialog.
- Input cancellation leaves the session unchanged.
- An unknown explicit profile fails before classification.
- A nested `/quickfix` invocation fails while another lifecycle is active.
- A session without an origin leaf reports that quick-fix branch entry is unavailable.

### Classification errors

If classification fails, the extension shows the profile selector. It continues without a summary after profile selection.

If the user cancels the selector, the extension leaves the session unchanged.

### Branch-entry errors

The extension does not mark quick-fix mode active until navigation and skill resolution succeed.

If navigation fails, the extension reports the error and keeps the origin active.

If initial message submission fails, the filtered branch remains active. The extension places the request in the editor for manual submission.

### Return errors

`/end-quickfix` waits for the current response to settle before navigation.

If return navigation fails, the extension keeps the active state and widget. Filtering remains active so the branch does not revert to the normal workflow prompt.

The user can correct the session problem and retry `/end-quickfix`.

### Git state

The extension never invokes Git for cleanliness checks. It does not inspect, stash, reset, clean, or restore worktree changes.

## Testing

The extension contains reusable state, parsing, and filtering logic. Automated tests pass the Testing Value Gate.

### Classification tests

Tests cover:

- every valid profile marker.
- high- and low-confidence output.
- `ambiguous` output.
- missing or malformed markers.
- explicit profile precedence.
- classifier failure fallback.
- selector cancellation.

### Prompt-filter tests

Tests cover:

- exact profile skill selection.
- preservation of Pi tool instructions.
- preservation of project context.
- removal of the normal appended Superpowers prompt.
- removal of unselected skills.
- absence of `brainstorming` and `writing-plans`.
- filtering on follow-up turns.
- no filtering on the origin or an unrelated branch.
- missing required skill errors.

### Lifecycle tests

Tests cover:

- origin capture before navigation.
- successful branch entry and prompt submission.
- classification fallback to the selector.
- submission failure with editor recovery.
- `/end-quickfix` return ordering.
- branch preservation after return.
- return failure with active-state preservation.
- manual navigation cleanup.
- session switch, fork, new-session, and reload cleanup.
- nested quick-fix refusal.

### Tool-gate tests

Tests cover blocked `subagent` and `run_team` calls. They also make sure that unrelated tools remain available.

### Direct verification

A direct Pi TUI test must cover:

- automatic profile selection.
- ambiguous classification and selector fallback.
- interactive follow-up messages.
- the active-profile widget.
- effective prompt inspection.
- blocked orchestration tools.
- `/end-quickfix` return behavior.
- preservation of the quick-fix branch.

The effective quick-fix prompt must not contain `brainstorming`, `writing-plans`, or the normal Superpowers appendix.

Final verification must include:

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
```

## Packaging

The new extension lives under `extensions/quickfix/`. The existing Pi resource packaging discovers and installs it with the other project extensions.

The runtime extension-load check must load the extension through the Home Manager-like resource layout. A successful Nix build alone is not sufficient.

## Migration and compatibility

The extension adds two commands and does not change normal Pi turns. The filter runs only when quick-fix state is active on the marked branch.

Existing sessions, authentication, model settings, project trust, tools, and extensions remain unchanged.

The implementation targets the public Pi 0.84.2 extension APIs. It does not import private Pi modules.

## Alternatives rejected

### Use `/run` with a custom agent

This provides fresh context and selected skills. It does not attach the current TUI to the child session.

### Use a prompt workflow

`/prompt-workflow` can choose a subagent, fresh context, and skills. It still returns a child result instead of entering an interactive branch.

### Attach the TUI to a `pi-subagents` child

Pi has no public API that attaches the current TUI to a child session. A proxy would duplicate session, streaming, cancellation, and tool lifecycle behavior.

### Replace the complete system prompt

A complete replacement gives strong isolation. It can lose Pi tool instructions, project context, and future prompt improvements.

### Keep the normal skill catalog and add a quick-fix instruction

This leaves `brainstorming` and `writing-plans` visible. The model can still enter the full workflow, so this option does not meet the structural-exclusion requirement.
