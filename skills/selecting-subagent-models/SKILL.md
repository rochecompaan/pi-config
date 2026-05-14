---
name: selecting-subagent-models
description: Use when dispatching subagents and choosing models, thinking levels, agent teams, worker/reviewer/planner/scout roles, or avoiding ad hoc model selection
---

# Selecting Subagent Models

Use configured agent teams before making any subagent model-selection decision.

**Core rule:** session-selected team > Pi agent defaults. Never guess provider/model strings when a team preset exists.

## When to Use

Use this alongside workflows such as `subagent-driven-development`, planning, review fanout, scout/research handoffs, or any `subagent(...)` call where model or thinking level matters.

## Team Resolution

If the `resolve_agent_team` tool is available, use it first. If it reports no session team, ask the human which team to use for this session or confirm Pi defaults. If the tool is unavailable, follow the file-based preset lookup below.

Before dispatching role-based subagents (`scout`, `planner`, `reviewer`, `worker`, `mechanical-worker`):

1. Check whether a team has already been selected in this conversation.
2. If not, ask the human which team to use for this session. Offer available presets from project-local `.pi/agent-teams/*.json` first, then global `~/.pi/agent/agent-teams/*.json` when possible.
3. If the human chooses a team for the session, read `.pi/agent-teams/<team>.json` if present; otherwise read `~/.pi/agent/agent-teams/<team>.json`.
4. For each subagent role, pass the preset's `model` and `thinking` explicitly in the `subagent(...)` call.
5. If the human declines to choose a team or says to use defaults, omit `model`/`thinking` and use Pi agent defaults.

## Preset Format

```json
{
  "name": "openai-only",
  "agents": {
    "scout": { "model": "openai-codex/gpt-5.4-mini", "thinking": "medium" },
    "planner": { "model": "openai-codex/gpt-5.5", "thinking": "high" },
    "reviewer": { "model": "openai-codex/gpt-5.5", "thinking": "high" },
    "worker": { "model": "openai-codex/gpt-5.4", "thinking": "medium" },
    "mechanical-worker": { "model": "openai-codex/gpt-5.4-mini", "thinking": "medium" }
  }
}
```

## Dispatch Pattern

If active team maps the role:

```typescript
subagent({
  agent: "worker",
  model: "openai-codex/gpt-5.4",
  thinking: "medium",
  task: "Implement the approved task..."
})
```

If the role is missing from the preset:

- Do not invent a model.
- Use the agent default for that one role, or ask the human if the missing role is important.
- Report the incomplete preset briefly: `Team <name> has no entry for <role>; using agent default for that role.`

## Optional Extension

If an `agent-team` Pi extension is installed, prefer it for visibility and switching:

- `/agent-team status` — show session-selected team and resolved role mappings
- `/agent-team list` — list available project-local and global presets
- `/agent-team use <team>` — select a team for this conversation/session
- `/agent-team clear` — clear the session-selected team
- `/agent-team validate` — check preset files and configured models

The extension manages preset visibility and session selection; this skill governs agent behavior when dispatching subagents. Team selection is conversation/session state, not config writes.

## Red Flags

| Thought | Reality |
|--------|---------|
| "I'll try openai/foo, then openai-codex/foo" | Trial-and-error model strings wastes time; read the configured team. |
| "The upstream skill says cheap/standard/strong, I'll decide manually" | Team presets override heuristics. |
| "I'll edit `.pi/agents/worker.md` to switch teams" | Switching teams must not mutate agent definition files. |
| "No team is set, I'll silently use my favorite team" | Ask which team to use for this session. |
| "I know the user's preferred team from old chat history" | Current conversation/session selection wins; otherwise ask. |

## Quick Checklist

- [ ] Checked whether this conversation already selected a team
- [ ] Asked the human for a session team when none is selected
- [ ] Loaded `~/.pi/agent/agent-teams/<team>.json` when a session team is selected
- [ ] Passed explicit `model` and `thinking` for mapped roles
- [ ] Did not guess or trial provider/model strings
- [ ] Did not mutate agent files to switch teams
