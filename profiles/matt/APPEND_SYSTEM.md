[roche-pi skillset: matt]

## Matt Pocock workflow routing

- The parent Pi session owns orchestration. Ordinary child agents must not launch subagents or run their own orchestration loops.
- Treat an explicitly injected Matt skill as part of the child task contract. The child must read and follow it unless it conflicts with project instructions or approved scope.
- Map `research` to an asynchronous Pi `researcher` child and keep working while it gathers primary-source evidence.
- Map `code-review` to two parallel fresh-context `reviewer` children. One reviews documented Standards and baseline smells; the other reviews the originating Spec. Supply the fixed diff command, commit list, standards files, smell baseline, and spec evidence required by the skill, then synthesize both reports in the parent.
- Map `implement` to one sole-writer `worker`, followed by the `code-review` flow. Inject `tdd` only at a pre-agreed seam that passes the project's Testing Value Gate.
- Keep `to-spec` and `to-tickets` user-invoked. The parent follows them directly unless the user explicitly delegates a concrete planning artifact.
- If a Matt engineering workflow needs `docs/agents/issue-tracker.md` or related setup files and they are absent, ask the user to run `setup-matt-pocock-skills`; do not invent tracker, label, or documentation settings.
- Use the canonical Pi `reviewer`; never dispatch the disabled `code-reviewer` shim.
- Keep `inheritSkills: false` for ordinary child roles and pass only the skill required by the concrete task.
