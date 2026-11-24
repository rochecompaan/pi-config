# Agent notes

How to start a fresh-context reviewer and choose its model in the coding
agents most of the team uses. Check the names below against your installed
version's help before you rely on them.

## Any agent

- Start the reviewer as a subagent of the current session, with a fresh
  context. Do not start a separate agent process from the command line. It
  runs outside the session's setup and can be billed differently.
- The reviewer needs the filled-in prompt, `review-criteria.md`, and a way to
  read the diff. If the reviewer cannot run shell commands, save the diff
  first and name the files in the prompt. `<pr>` is the PR number, so
  reviews of two PRs on one machine do not overwrite each other's files:

  ```bash
  git diff --stat <base>..<reviewed> > /tmp/pr-review-loop-<pr>-r<round>.stat
  git diff <base>..<reviewed> > /tmp/pr-review-loop-<pr>-r<round>.diff
  ```

- Start the reviewer from the repository root, so it can read the files the
  diff touches.
- Give the reviewer read-only tools when the agent lets you choose.

## Pi

- Start the reviewer with the `subagent` tool, agent `reviewer`, with a fresh
  context (not a fork of your session).
- Pass the model explicitly as `provider/id`. An omitted model inherits your
  session's model.
- When both are configured, alternate between an OpenAI model and an
  Anthropic model.
- The `reviewer` agent's tools depend on your configuration. Check its tool
  list before the first round. Save the diff to files only when it has no
  shell. When it has a shell, the read-only rule rests on the prompt alone.
- If the subagent fails because its model provider needs an extension that a
  foreground subagent does not load, start it as a background (async)
  subagent instead.

## Claude Code

- Start the reviewer with the Agent tool (called Task in older versions). Use
  a read-only reviewer agent if the project defines one. Choose its model
  with the tool's `model` setting.
- Claude Code subagents run only Claude models, so the run uses one model
  family. Say so in the Result line, as `SKILL.md` describes.
