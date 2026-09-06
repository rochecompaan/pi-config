# Snip actions extension design

## Status

Approved in conversation on 2026-09-05. Revised after the Pi 0.84.4 interactive-command test.

## Problem

Pi provides `/copy` to copy the latest assistant message. The command does not let the user select a message or an extracted part.

Pi 0.84.4 handles exact built-in interactive commands before it sends input to the extension command dispatcher. As a result, an extension command named `/copy` does not receive exact `/copy` input. `/copy probe` reaches extension dispatch because the built-in handler only matches exact `/copy`.

The Signalridge `pi-code-actions` extension provides a searchable picker for fenced code and inline code. It uses a separate `/code` command and does not include full messages.

Models sometimes format text for another application with a `| ` prefix on each line. The user needs to copy this text without the prefixes or newline characters.

## Goals

- Provide one searchable picker through `/snip`.
- Keep Pi's built-in `/copy` command unchanged.
- Avoid a custom Pi command-dispatch patch.
- Include full assistant messages from the active branch.
- Include fenced code blocks from assistant messages.
- Include every single-backtick inline-code span outside fenced blocks.
- Include cleaned blocks of pipe-prefixed lines.
- Copy all item types to the system clipboard.
- Insert fenced and inline code into the Pi editor.
- Use Pi's configured selection keys and clipboard implementation.
- Keep the extraction logic independent from the TUI.
- Retain the required attribution for the upstream MIT-licensed code.

## Non-goals

- Do not include user, tool, bash, summary, or custom messages.
- Do not execute selected code.
- Do not add a direct selector or a latest-message fast path.
- Do not support message insertion into the editor.
- Do not modify stored session messages.
- Do not parse general Markdown block quotes.
- Do not publish a separate npm package.
- Do not override any built-in interactive command.

## User interface

The extension registers `/snip`. This name does not conflict with a Pi 0.84.4 built-in interactive command.

Plain `/snip` opens one searchable picker. The picker contains all supported items from the active branch.

Arguments do not select a fast path. For example, `/snip probe` opens the same picker as plain `/snip`.

The picker selects the latest full assistant message by default. It shows a type label, a message time, and a compact content preview.

The item labels are:

- `message` for a full assistant message
- `pipe message` for a cleaned pipe-prefixed block
- `code` for a fenced code block
- `inline` for a single-backtick inline-code span

The picker supports these actions:

| Key | Action |
|---|---|
| Configured selection keys | Move through results |
| Typed text | Filter results |
| Configured confirm key | Copy the selected item |
| Right Arrow | Insert a selected `code` or `inline` item |
| Configured cancel key | Close the picker without an action |

The picker does not advertise Right Arrow for `message` or `pipe message` items. The picker stays open after this key input.

## Copy item model

The extraction module returns one discriminated `CopyItem` type. The interface contains only data that the picker and action dispatcher need.

Each item contains:

- an ephemeral identifier
- an item kind
- the text for copying or insertion
- the source message identifier
- the source timestamp
- an optional code language
- the source position for stable ordering

The item kind determines the permitted actions. `code` and `inline` items permit copy and insert. Other items permit copy only.

## Assistant text

The collector reads `ctx.sessionManager.getBranch()`. It keeps message entries with the `assistant` role.

For each assistant message, the collector joins its text content blocks with two newline characters. It ignores thinking and tool-call content blocks.

The collector skips an assistant message that has empty resulting text.

## Extraction rules

### Full messages

Each non-empty assistant message produces one `message` item. Its content is the complete extracted assistant text without changes.

The raw full-message item keeps pipe prefixes and newline characters. The cleaned pipe item gives the user a separate copy choice.

### Fenced code

A fenced block starts with three backticks and ends with three backticks. The extracted content excludes both fences.

The optional text after the opening fence becomes the language label. Fenced items retain their internal newline characters.

### Inline code

A single-backtick span outside fenced code produces one `inline` item. The extracted content excludes the backticks.

The extension does not apply the upstream path filter or ignored-command list. Every non-empty single-backtick span becomes an item.

### Pipe-prefixed messages

A pipe-prefixed line starts with the exact two-character prefix `| `. Leading indentation does not match this rule.

One or more consecutive matching lines form one `pipe message` item. A non-matching line ends the block.

The extractor removes the first `| ` prefix from each line. It then joins the remaining line content with an empty separator.

For example:

```text
| Hello,
|this does not match
| world
```

This input produces two separate items. The first item contains `Hello,`. The second item contains `world`.

For a consecutive block:

```text
| Hello,
| world
```

The copied content is:

```text
Hello,world
```

The extractor preserves all characters after each removed prefix. This includes trailing spaces.

Pipe-prefixed lines inside fenced code do not produce pipe-message items. The extractor skips a pipe item that has empty cleaned content.

## Ordering and search

The collector processes assistant messages from newest to oldest. For each message, it adds the full-message item first.

The collector adds extracted items after the full message. It orders these items by their source position in the message.

The picker search index contains:

- the item label
- the source timestamp
- the content
- the optional code language

The picker uses the upstream normalized fuzzy-ranking behavior. It does not remove duplicate content because full messages and extracted items serve different copy tasks.

## Actions

### Copy

The copy adapter calls Pi's exported `copyToClipboard()` function. This function includes Pi's platform support and OSC 52 fallback.

A successful copy shows a short notification with the item type. A clipboard error shows the error message from Pi.

### Insert

The insert adapter supports `code` and `inline` items only. It reads the current editor text before insertion.

If the editor is empty, the adapter sets the editor to the item content. If the editor has text, it appends one newline and the item content.

A successful insertion shows `Inserted code into editor.` The command does not close or modify the session branch.

## Architecture

The extension uses this file structure:

```text
extensions/snip-actions/
├── index.ts
├── actions.ts
├── copy-items.ts
├── extract.ts
├── search.ts
├── ui.ts
└── NOTICE
```

### `index.ts`

This module exports `registerSnipActions()` and registers `/snip`. It coordinates collection, picker selection, and action dispatch.

### `copy-items.ts`

This module defines `CopyItem`. It collects assistant text from the active branch and controls result ordering.

### `extract.ts`

This module implements fenced, inline, and pipe-message extraction. Its interface accepts text and returns extracted items without TUI dependencies.

### `search.ts`

This module builds the search index and ranks matches. It adapts the upstream search behavior to `CopyItem`.

### `ui.ts`

This module owns the searchable picker. It returns a selected item and an allowed action.

### `actions.ts`

This module adapts Pi's clipboard and editor interfaces. It does not contain extraction or search rules.

## Data flow

1. The user invokes `/snip`.
2. `index.ts` makes sure that the command runs in interactive TUI mode.
3. `copy-items.ts` reads assistant messages from the active branch.
4. `extract.ts` produces the extracted items for each message.
5. `copy-items.ts` combines and orders the full and extracted items.
6. `ui.ts` shows the searchable picker.
7. The picker returns an item and an allowed action.
8. `actions.ts` copies the item or inserts code into the editor.
9. Pi shows the result notification.

## Error handling

If the command does not run in TUI mode, it returns without opening custom UI. If UI notifications are available, it shows an interactive-mode warning.

If the active branch has no non-empty assistant text, the command shows `No assistant messages to copy.`

If the user cancels the picker, the command makes no changes and shows no notification.

If clipboard access fails, the command catches the error and shows its message. The Pi session remains active.

The picker prevents unsupported insert actions. The action dispatcher also rejects them as a defense against invalid internal values.

## Testing

The automated tests cover behavior that can regress and that is independent from static configuration.

### Extraction tests

- Extract fenced code without fences.
- Extract every non-empty single-backtick span.
- Ignore inline matches inside fenced code.
- Group consecutive `| ` lines.
- Split pipe blocks at non-matching lines.
- Remove exactly one `| ` prefix from each matching line.
- Join cleaned pipe lines without a separator.
- Preserve characters after the removed prefix.
- Ignore pipe-prefixed lines inside fenced code.
- Skip empty extracted items.

### Collection tests

- Include full assistant messages.
- Exclude other message roles and non-text content.
- Put the newest assistant message first.
- Put each full message before its extracted items.
- Keep extracted items in source order.

### Command and action tests

- Register `/snip` and open its picker.
- Keep command arguments on the normal picker path.
- Copy each item type through the clipboard adapter.
- Insert fenced and inline code into an empty or non-empty editor.
- Reject insertion for full and pipe-message items.
- Make no change after cancellation.
- Show useful messages for an empty branch and clipboard errors.

The Testing Value Gate excludes tests that only inspect Nix paths or static file lists. Direct build checks cover that configuration.

## Direct verification

Run these commands after implementation:

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
```

The extension-load check must load the new extension without module or import errors.

A manual TUI check must show that exact `/snip` opens the unified picker. The check must also show that exact `/copy` keeps its built-in behavior.

The manual check must cover full-message copying, cleaned pipe copying, code copying, and code insertion. It must cover search, cancellation, unsupported insertion, and narrow-width metadata.

## Packaging

`modules/packages/pi-config.nix` already copies the complete `extensions/` directory into the Pi configuration package. The `snip-actions` extension needs no extra Nix package declaration.

The implementation must use package imports that match the Pi version in this repository. Tests must not require runtime dependencies outside the packaged Pi closure.

## Attribution

This extension derives from `@signalridge/pi-code-actions`:

- Source: <https://github.com/signalridge/pi-extensions/tree/main/packages/pi-code-actions>
- Copyright: `Copyright (c) 2026 Thomas Mustier`
- License: MIT

The `NOTICE` file will include the upstream copyright and MIT permission notice. Adapted source files will retain a short derivation comment where substantial upstream code remains.

## Alternatives rejected

### Override Pi's built-in `/copy`

Pi 0.84.4 dispatches exact built-in interactive commands before extension commands. A Pi patch can reverse that priority, but the change affects every built-in command.

The patch also adds package maintenance, command-precedence tests, and upgrade risk. `/snip` provides the picker without those changes and keeps built-in `/copy` available.

### Minimal single-file fork

This option reduces the first edit but mixes extraction, UI, search, and actions. It makes later changes and focused tests harder.

### Wrapper around the upstream package

The upstream modules do not expose a stable interface for a unified picker. A wrapper also leaves command ownership and action rules split across two extensions.

### Two-stage category picker

A category screen adds a step to every copy action. One searchable picker gives direct access to all supported item types.

### Preserve shell execution

The extension focuses on copying and editor insertion. Shell execution adds risk and does not serve the pipe-message use case.

### Preserve the latest-message fast path

A fast path makes `/snip` behavior depend on arguments. The approved design always opens the unified picker.
