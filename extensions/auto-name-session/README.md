# Automatic session names

This extension gives sessions short names such as “auto name session”.
After each completed reply, it checks whether the topic changed.
It keeps the exact name while the topic stays the same.

It uses `openai-codex/gpt-6-luna` with low thinking.
The request contains the current name, the last two user messages, and the last reply to each message.
It skips intermediate progress messages.
Conversation data is limited to 4,000 characters.
Tools, images, and private model reasoning are excluded.

Each reply triggers at most one naming request.
The model returns `KEEP` or a short lowercase name.
The output budget is 256 tokens, which includes the model's reasoning.
Requests stop after ten seconds and do not retry until the next reply.
If Luna is unavailable, naming stops quietly instead of using another model.

In interactive and RPC modes, naming runs in the background.
A new prompt cancels an unfinished check.
A stale result cannot rename another session or a different branch.
Print and JSON modes wait for naming before the process exits.

If you set a name with `/name`, the extension leaves it unchanged.
Automatic names remain eligible for updates after you resume a session or reload extensions.
Existing names without an automatic-name record count as manual names.

The Nix package includes this extension through the existing `extensions` directory.
To try it without rebuilding your configuration, run this command from the feature worktree:

```sh
pi -e ./extensions/auto-name-session
```

The OpenAI Codex provider must already be authenticated in Pi.
