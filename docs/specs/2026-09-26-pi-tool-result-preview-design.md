# Pi Tool-Result Preview Design

## Summary

Pi rebuilds all visible tool components after a session-tree jump. A collapsed fallback component processes the full tool output before it limits the visible lines.

A large one-line result can therefore block the terminal for several seconds. The measured 36 MB session rebuild took 23.2 seconds.

This change adds a temporary downstream patch for Pi 0.87.1. The patch keeps collapsed fallback work bounded and keeps full content available after expansion.

## Goals

- Rebuild the measured 36 MB transcript in less than one second on the same machine.
- Process at most 10,000 text characters for a collapsed fallback preview.
- Show at most 10 preview lines.
- Show at most 500 terminal columns from each preview line.
- Keep all result content available when the user expands the component.
- Apply the same limits when a saved tool no longer has a loaded definition.
- Keep one source patch that is suitable for an upstream Pi change.
- Remove the downstream patch after a Pi release contains the upstream fix.

## Non-goals

- This change does not alter session files or tool-result data.
- This change does not alter custom `renderResult` functions.
- This change does not add a user setting for preview limits.
- This change does not change the context-paging extension.
- This change does not update the pinned Pi version.

## Root cause

`ToolExecutionComponent` calls `getTextOutput()` before it limits the preview to 10 lines. `getTextOutput()` removes ANSI sequences and sanitizes binary data from every text block.

The work is proportional to the complete output size. A single long line bypasses the existing line limit because the component sanitizes that line before display.

The same path runs during transcript reconstruction. Session-tree navigation therefore repeats the expensive work for each visible tool result.

## Component behavior

The patch changes only the fallback paths in `ToolExecutionComponent`.

For a collapsed component, the component builds a preview result before it calls `getTextOutput()`. The preview result includes these items:

- The first 10,000 text characters across text blocks.
- Image blocks, so existing image fallback behavior remains available.
- The original result metadata.

The component records whether it omitted text. It then sanitizes only the preview result.

For a fallback result renderer, the component keeps the first 10 lines. It also limits each visible line to 500 terminal columns.

The component shows an expansion hint when it omits characters, lines, or columns. It does not report an exact omitted-line count after the character limit applies.

For a tool without a loaded definition, the generic fallback uses the same bounded result preview. It also shows the expansion hint.

When the user expands either fallback, the component passes the original result to `getTextOutput()`. Expansion therefore preserves the complete output.

## Downstream package structure

A focused Nix module wraps the Pi derivation from `llm-agents.nix`. The wrapper applies the compiled JavaScript patch to the Pi 0.87.1 npm artifact.

Both Pi package consumers use this wrapper:

- `modules/packages/pi.nix` uses it for the selectable Pi launchers.
- `modules/packages/pi-config.nix` uses it for version data and runtime checks.

The wrapper also runs a Node regression test during the Pi build. The test imports the patched unbundled component before the Bun binary is assembled.

The repository keeps a separate upstream patch. That patch changes the TypeScript source and the upstream Vitest file.

## Test design

The regression test covers these behaviors:

1. A guarded text value fails if sanitization starts before preview slicing. The unpatched component fails this test.
2. A collapsed one-line result omits content after the character and column limits.
3. A collapsed multi-line result shows no more than 10 preview lines.
4. An expansion shows a marker that was absent from the collapsed preview.
5. A tool without a loaded definition has the same collapsed and expanded behavior.
6. Image blocks remain in the preview input when the text limit is complete.

The test uses the real `ToolExecutionComponent` and the real text sanitizer. It uses a small fake TUI object because the test does not start an interactive terminal.

## Verification

The implementation must pass these commands:

```sh
nix build .#packages.x86_64-linux.pi --no-link
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
```

A benchmark must repeat the earlier 36 MB reconstruction case. The target is less than one second on the same machine.

No new test will assert Nix source text or static patch content. The package build and runtime checks verify the applied behavior.

## Risks and controls

A fixed character limit can split a Unicode grapheme or an ANSI sequence. The sanitizer already accepts incomplete terminal sequences, and the visible column limit prevents an oversized preview.

The compiled patch and upstream source patch can diverge. The downstream Node test and the upstream Vitest test use the same behavior cases.

An upstream Pi update can make the patch fail to apply. This is intentional because a failed build is safer than a silent partial patch.

## Removal

When a Pi release contains this behavior, remove these items in one change:

- The downstream Pi wrapper.
- The compiled JavaScript patch.
- The downstream regression test.
- The upstream source patch.

Then point both package consumers back to the unmodified `llm-agents.nix` Pi derivation. Run the full verification commands after the removal.
