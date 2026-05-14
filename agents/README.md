# Pi Agent Profiles for Superpowers

This directory contains Pi-specific agent profiles used by Superpowers subagent workflows.

## Included profiles

- `scout.md` — fast repository reconnaissance and handoff context.
- `planner.md` — implementation planning from approved requirements.
- `reviewer.md` — fresh-context adversarial review.
- `worker.md` — standard single-writer implementation.
- `mechanical-worker.md` — narrow deterministic implementation.
- `code-reviewer.md` — used by `requesting-code-review` and workflows that depend on it.

## Installation

Install these profiles into your Pi user agents directory:

```bash
mkdir -p ~/.pi/agent/agents
ln -sf ~/.pi/agent/git/github.com/obra/superpowers/.pi/agents/code-reviewer.md ~/.pi/agent/agents/code-reviewer.md
```

If Superpowers is installed from a local path, replace the source path accordingly.
