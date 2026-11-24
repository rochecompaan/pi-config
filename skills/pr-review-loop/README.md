# PR Review Loop

`pr-review-loop` moves agent code review to the author's side, before a
person reviews the PR. The author runs up to three rounds of fresh agent
review and fixes on an open PR, and the skill records every finding and how
it was handled in the PR description.

This replaces the pattern where a reviewer's agent posts a review, the
author's agent answers it, and people pass messages between agents.

## What it does

1. Checks that the PR is open, the branch is pushed, and the working tree is
   clean.
2. Runs up to three rounds. Each round starts a fresh reviewer on the whole
   branch, fixes accepted findings with one commit each, validates, and
   pushes. Model families alternate between rounds when more than one is
   available.
3. Asks the author to approve every declined or deferred finding.
4. Stops after a clean round or after three rounds.
5. Writes a "Review evidence" section into the PR description.
6. Asks which deferred findings should become issues.

Run it again after you push code changes, for example in answer to a human
reviewer. Each run adds its rounds to the same evidence section.

## What it writes

A "Review evidence" section in the PR description, between hidden markers.
A human reviewer sees only a short summary:

- the result of the latest run and the commit the evidence covers;
- what the human reviewer should check;
- the fixed Critical and Important findings, and a count of Minor fixes;
- one line for each declined or deferred finding.

A collapsed review log holds the rest: the rounds, every finding, and the
validation results.

Each round's full reviewer report goes in its own collapsed PR comment, not
in the description, so the description stays well below GitHub's size
limit. The rounds table links each report. These comments are the only ones
the skill posts.

See [`assets/evidence-template.md`](assets/evidence-template.md).

## Install

### For a project

Copy this folder into the project and link it for Claude Code:

```bash
mkdir -p .agents/skills .claude/skills
cp -R /path/to/the-promptorium/skills/pr-review-loop .agents/skills/
ln -s ../../.agents/skills/pr-review-loop .claude/skills/pr-review-loop
```

Pi and other Agent Skills tools read `.agents/skills/`. Claude Code reads
`.claude/skills/`.

Then add the text in
[`assets/pr-review-guidance.md`](assets/pr-review-guidance.md) to the
project's `AGENTS.md` or contributor docs.

### For yourself

Link the folder into your personal skills directory, as
[Agent Skills + Claude Code Integration](https://github.com/sixfeetup/the-promptorium/blob/main/docs/claude-code-integration.md)
describes:

```bash
ln -s /path/to/the-promptorium/skills/pr-review-loop ~/.agents/skills/pr-review-loop
ln -s /path/to/the-promptorium/skills/pr-review-loop ~/.claude/skills/pr-review-loop
```

## Guidance for human reviewers

Agent correctness review happens on the author's side, before a person
reviews the PR.

- Authors run the `pr-review-loop` skill before they request human review.
  They run it again after they push code changes, including changes made in
  answer to a human reviewer.
- We strongly recommend that human reviewers do not run agents for
  correctness reviews or post agent-written reviews. The author's loop
  already covers correctness, and agent reviews on the PR bring back the
  back-and-forth between agents that the loop replaces.
- Human reviewers check that the commit in the PR's "Review evidence"
  section matches the PR head. They read the visible summary: the items to
  check, the fixes, and the declined and deferred findings. Then they look at what smells off,
  maintainability, and fit with the spec.
- A reviewer who doubts the evidence asks the author to run another loop.

## Sources

The reviewer prompt is adapted from
[Superpowers](https://github.com/obra/superpowers) (MIT). The review criteria
are adapted from [Patchmill](https://github.com/rochecompaan/patchmill),
with its author's permission.
