# pi-subagents Model Profiles Design

## Context

The repository upgraded `pi-subagents` to version 0.58.0 in commit `674865f`. This version supports named model profiles in `~/.pi/agent/profiles/pi-subagents/<name>.json` and adds the commands `/subagents-profiles`, `/subagents-check-profile <name>`, and `/subagents-load-profile <name>`.

`/subagents-load-profile` rewrites the global `subagents.agentOverrides` mapping in `~/.pi/agent/settings.json`. Agent discovery rereads that file on every launch, so a loaded profile affects new subagent launches from every open Pi session. The user rejected this global switching. The requirement is session-local behavior: one Pi session may launch OpenAI subagents while another session, open at the same time, launches Kimi subagents.

Source inspection of `pi-subagents` 0.58.0 confirmed a session-local mechanism. The model resolution order at launch time is:

1. An explicit `model` parameter on the `subagent` tool call (`resolveEffectiveSubagentModel` resolves `explicitModel ?? agentModel`).
2. The agent's configured model: project `.pi/settings.json` `agentOverrides` win over user `~/.pi/agent/settings.json` `agentOverrides` per agent, which win over builtin defaults.
3. The parent session model, when the launch requests inheritance.

The explicit `model` parameter accepts a thinking suffix in the form `provider/id:thinking`. It works for single launches, per-task in parallel launches, and per-step in chain launches. No settings file changes.

Two other candidate mechanisms were rejected:

- Session-scoped `watchdog.configure` supports `target = "main"` only. It cannot route per-role child models.
- Project `.pi/settings.json` overrides apply to every session in the same directory. They are not session-local.

## Goals

- Manage two profile files in this repository: `openai.json` and `kimi.json`.
- Deploy both files to `~/.pi/agent/profiles/pi-subagents/` on the Home Manager and jailed Pi launch paths.
- Keep the current OpenAI `agentOverrides` in `settings.json` as the permanent global baseline.
- Apply a profile session-locally: the parent session passes explicit `model` parameters on each subagent launch. Nothing writes to any settings file.
- Validate both profiles with `/subagents-check-profile`. Keep `/subagents-load-profile` available as a manual global escape hatch.
- Document the session behavior in a new skill so any parent session can apply a profile on request.

## Non-goals

- Do not change `settings.json` or any existing resource wiring beyond the additions listed here.
- Do not build reset machinery. No global state changes, so there is nothing to reset. A new session always starts on the OpenAI baseline.
- Do not change `run_team` multi-model planning teams. They define their own model sets.
- Do not change the watchdog configuration.
- Do not change the model of an already-running subagent.
- Do not add automated tests for the profile JSON files or the skill prompt. The Testing Value Gate excludes static configuration and prompt text. The Verification section lists the command-based checks.

## Profile files

The files live in `profiles/pi-subagents/` in this repository. This mirrors the canonical target layout `~/.pi/agent/profiles/pi-subagents/`. The existing `profiles/matt/` and `profiles/superpowers/` directories hold prompt profiles and are unaffected.

Both files use the upstream profile schema. Each entry supports `model`, `thinking`, and an optional `fallbackModels` list. This design uses `model` and `thinking` only.

`profiles/pi-subagents/openai.json` mirrors the current baseline exactly:

```json
{
  "subagents": {
    "agentOverrides": {
      "scout": { "model": "openai-codex/gpt-5.6-luna", "thinking": "low" },
      "delegate": { "model": "openai-codex/gpt-5.6-luna", "thinking": "low" },
      "researcher": { "model": "openai-codex/gpt-5.6-terra", "thinking": "medium" },
      "context-builder": { "model": "openai-codex/gpt-5.6-terra", "thinking": "medium" },
      "planner": { "model": "openai-codex/gpt-5.6-sol", "thinking": "xhigh" },
      "worker": { "model": "openai-codex/gpt-5.6-terra", "thinking": "high" },
      "reviewer": { "model": "openai-codex/gpt-5.6-sol", "thinking": "xhigh" },
      "oracle": { "model": "openai-codex/gpt-5.6-sol", "thinking": "high" }
    }
  }
}
```

`profiles/pi-subagents/kimi.json` adds the Kimi mapping. K3 supports the thinking levels `low`, `high`, and `max`; it does not support `medium` or `xhigh`. The mapping uses only supported levels:

```json
{
  "subagents": {
    "agentOverrides": {
      "advisor": { "model": "kimi-coding/k3", "thinking": "high" },
      "context-builder": { "model": "kimi-coding/k3", "thinking": "high" },
      "delegate": { "model": "kimi-coding/k3-256k", "thinking": "low" },
      "mechanical-worker": { "model": "kimi-coding/k3-256k", "thinking": "low" },
      "oracle": { "model": "kimi-coding/k3", "thinking": "high" },
      "planner": { "model": "kimi-coding/k3", "thinking": "max" },
      "researcher": { "model": "kimi-coding/k3-256k", "thinking": "high" },
      "reviewer": { "model": "kimi-coding/k3", "thinking": "max" },
      "scout": { "model": "kimi-coding/k3-256k", "thinking": "low" },
      "worker": { "model": "kimi-coding/k3", "thinking": "high" }
    }
  }
}
```

The Kimi profile covers ten roles: the eight builtin roles from the baseline plus `advisor` and `mechanical-worker`. Roles absent from a profile keep their baseline behavior when launched.

## Nix deployment

- `nix/lib/pi-resources.nix`: add `subagentProfiles = "${package}/profiles/pi-subagents"`, export it, and link it as `profiles/pi-subagents` in `resourcesPackage` so the packaged layout matches the Home Manager layout.
- `modules/packages/pi-config.nix`: copy the repository `profiles/pi-subagents` directory into the package. The package build copies each resource directory explicitly, and `profiles/` is not copied today.
- `modules/home/pi.nix`: add a `home.file` entry that links `.pi/agent/profiles/pi-subagents` to `piResources.subagentProfiles`.
- `modules/home/jailed-pi.nix`: add the corresponding link in the jailed activation script so jailed sessions see the same profiles.
- `nix/packages/pi-deps.nix`: no changes.

No other settings or wiring change.

## Session contract skill

Add `skills/subagent-model-profiles/SKILL.md`. The existing skills packaging deploys it to `~/.pi/agent/skills/` without further wiring.

The skill defines this contract for the parent session:

- Trigger phrases include "use kimi", "switch subagents to kimi", "use openai", and "back to defaults".
- On activation, the parent reads `~/.pi/agent/profiles/pi-subagents/<name>.json`. For every later subagent launch, it passes each role's entry as the `model` parameter in the form `provider/id:thinking`. This applies to single launches, per-task `model` in parallel launches, and per-step `model` in chain launches.
- On a switch, the parent applies the new profile. On "back to defaults", the parent stops passing per-launch models and the global OpenAI baseline takes over.
- When the parent launches a role that the active profile does not list, it passes no `model` parameter.
- If the profile file is missing or invalid, the parent stops, reports the problem, and suggests a Home Manager rebuild or `/subagents-check-profile <name>`.
- Profiles cover the eight baseline roles plus `advisor` and `mechanical-worker`. `advisor` is also a builtin role; the baseline simply leaves it unmapped. `mechanical-worker` is a project custom agent in this repository; in other projects the entry is unused.

## Error handling

- An unknown or unavailable model identifier fails the affected launch with the normal `subagent` tool error. The parent reports it and does not retry with a different model on its own.
- A launch that misses its per-launch model degrades softly to the baseline model for that role. The system keeps working; only the model choice differs.
- Session compaction can drop the active-profile state. After compaction, the parent recovers the state from the conversation when visible, or the user restates the activation. The skill states this explicitly.

## Verification

Profile JSON files and the skill prompt are static content, so no new automated tests. Verify with commands instead:

1. `nix build .#checks.x86_64-linux.pi-config-extension-load --no-link`
2. `nix flake check --accept-flake-config --print-build-logs`
3. After a Home Manager rebuild, run `/subagents-check-profile openai` and `/subagents-check-profile kimi` in a Pi session. Both must pass.
4. Live smoke test: in a Pi session, activate the Kimi profile, launch a `scout` subagent, and confirm the run reports `kimi-coding/k3-256k`. Open a second session without activation, launch a `scout`, and confirm it still reports `openai-codex/gpt-5.6-luna`. This proves session-local isolation.

## Risks

- Profile application depends on parent behavior, not on tool enforcement. A parent that ignores the skill silently uses baseline models. The skill text, the smoke test, and the low cost of failure (a wrong but working model) make this acceptable.
- `subagents-status` and `subagent` model listings show the global baseline, not the session-active profile. Operators verify the active profile through launch results, not status output.
