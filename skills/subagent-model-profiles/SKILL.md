---
name: subagent-model-profiles
description: Use when the user asks to switch subagent models for the current session - "use kimi", "switch subagents to kimi", "use openai", "back to defaults". Applies a named pi-subagents profile to this session's subagent launches without changing global settings.
---

# Subagent model profiles

Profiles live at `~/.pi/agent/profiles/pi-subagents/<name>.json`. Each file maps
subagent roles to `{ "model": "provider/id", "thinking": "<level>" }` under
`subagents.agentOverrides`.

Available profiles: `openai`, `kimi`. OpenAI is the global baseline: with no
active profile, launches already use the OpenAI mapping from global settings.

## Rules

- Never run `/subagents-load-profile`. It rewrites the global settings and
  affects every open session.
- Never edit `settings.json` or `.pi/settings.json` to switch subagent models.

## Applying a profile

When the user activates a profile:

1. Read `~/.pi/agent/profiles/pi-subagents/<name>.json`. If the file is missing
   or invalid, stop, report the problem, and suggest a Home Manager rebuild or
   `/subagents-check-profile <name>`.
2. Keep the mapping active for the rest of the session, or until the user
   switches profiles or deactivates.
3. On every subagent launch, pass the launched role's entry as the model
   argument in the form `provider/id:thinking`:
   - single launch: the `model` parameter
   - parallel tasks: each task's `model` parameter
   - chains: each step's `model` parameter
4. For roles the profile does not list, pass no model parameter. Baseline
   behavior applies to them.

## Switching and deactivating

- "use openai" after another profile: apply `openai.json` the same way.
- "back to defaults" or "stop the profile": stop passing per-launch models.
  The global OpenAI baseline takes over.

## Notes

- Already-running subagents keep their model. The profile affects new launches.
- Status and model listings show the global baseline, not the session profile.
  Verify the active profile through launch results.
- Session compaction can drop the active profile. Recover it from the
  conversation when visible; otherwise ask the user to restate it.
