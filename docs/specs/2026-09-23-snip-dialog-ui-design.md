# `/snip` Dialog UI Design

**Date:** 2026-09-23
**Status:** Approved

## Problem

The current `/snip` overlay uses full-width horizontal rules but has no complete frame. Its list, preview, and help text therefore appear to flow into the session transcript behind the overlay. Users can identify the controls, but it is hard to see where the `/snip` dialog begins and ends.

Long shell commands also need almost the full terminal width. A narrow modal or side-by-side list and preview would make those commands harder to read.

## Goals

- Make the `/snip` dialog clearly separate from the session transcript.
- Preserve a stacked list-and-preview layout for long commands.
- Preserve almost all terminal width.
- Use a complete, bright frame with minimal padding.
- Give the preview its own distinct visual boundary.
- Keep the existing search, selection, copy, insert, paging, and responsive-height behavior.

## Non-goals

- Change how copy items are extracted, grouped, searched, or selected.
- Change keyboard shortcuts or copy and insert actions.
- Add a side-by-side layout.
- Add hard-coded colors for one theme.
- Replace Pi's overlay system.

## Approved Layout

The overlay remains stacked and uses a one-cell outer margin when the terminal has room. A complete single-line frame encloses the filter, result list, preview, and help row. Content uses one cell of horizontal padding.

The main dialog title is centered inside the top frame. The preview title is centered inside a contrasting double-line separator. The result list ends with one blank line before the preview separator. The preview content has one blank line above and below it.

```text
session text above the dialog…

 ┌────────────────── ✂ SNIP · COPY MESSAGE OR SNIPPET ────────────────────────────┐
 │ Filter: (none)                                                    2/26          │
 ├────────────────────────────────────────────────────────────────────────────────┤
 │ 6:02:34 PM · App-admin rotation completed successfully                         │
 │   Full message                                                                 │
 │ ▶ Code · bash  scripts/database_secret_rotation_checks.py drill-observations … │
 │                                                                                │
 │ 5:40:29 PM · The privileged evidence passes                                    │
 │   Full message                                                                 │
 │                                                                                │
 ╞════════════════════ PREVIEW · CODE · BASH · 6:02:34 PM ════════════════════════╡
 │                                                                                │
 │ scripts/database_secret_rotation_checks.py drill-observations \                 │
 │   --profile "$AWS_PROFILE" \                                                    │
 │   --cluster-id "$CLUSTER_ID" \                                                  │
 │   --secret-id "$APP_ADMIN_SECRET_ID"                                            │
 │                                                                                │
 ╞════════════════════════════════════════════════════════════════════════════════╡
 │ ↑↓ select · Enter copy · Right insert code · Esc close                         │
 └────────────────────────────────────────────────────────────────────────────────┘

session text below the dialog…
```

## Color and Type Treatment

Use Pi theme roles rather than fixed terminal colors:

- The complete outer frame, including corners and side rails, uses `borderAccent`.
- The centered dialog title uses `borderAccent` and bold text.
- The preview's top and bottom double-line separators use `mdHeading`.
- The centered preview title uses `mdHeading` and bold text.
- The selected row continues to use `selectedBg`.
- Code labels continue to use `mdCode`.
- Body, muted, and help text continue to use their existing semantic roles.

In the active Stylix theme, this produces a teal dialog frame (`#83a598`) and gold preview separators (`#fabd2f`). `mdCodeBlockBorder` is not suitable for the preview boundary in this theme because it resolves to a dark brown with too little contrast. The implementation must still use semantic theme roles, not these hex values.

## Layout Behavior

### Width

The overlay uses the available terminal width with a one-cell outer margin on each side when possible. The frame consumes one cell on each side, and the content uses one cell of inner padding. This keeps commands nearly full width while making the dialog boundary visible.

All padding, centering, truncation, and wrapping calculations must use ANSI-aware visible widths. No rendered line may exceed the width provided by Pi.

### Height

The existing priority remains:

1. Keep a usable selected result and its group header.
2. Keep the cancel/help row visible.
3. Show the preview when enough height is available.
4. Reduce or omit preview content before making the result list unusable.

When the preview is visible, its row budget includes:

- one blank row between the list and preview separator;
- the titled top separator;
- one blank row before preview content;
- preview content rows;
- one blank row after preview content;
- the bottom separator.

If the available height cannot fit these rows plus at least one preview content row, omit the preview entirely. Do not render the preview without its requested padding. The complete outer frame remains whenever the terminal can fit it.

### Centered Rules

The dialog and preview titles are centered according to visible terminal width. If a title is too wide, truncate the title before constructing the surrounding rule. Centering must remain correct when the text contains ANSI styling.

The outer frame uses single-line box characters. The preview boundary uses double-line horizontal characters and matching junctions so it remains distinct without adding side borders inside the dialog.

## Component Responsibilities

### `extensions/snip-actions/picker-layout.ts`

Own the geometry and vertical row budget. It should account for the outer frame, list-to-preview gap, preview padding, preview separators, help row, and short-terminal fallback. Pure layout helpers should remain free of theme-specific color decisions.

### `extensions/snip-actions/ui.ts`

Own theme application and final rendering. It should:

- apply `borderAccent` to the outer frame;
- apply `mdHeading` to preview rules and its title;
- center and truncate both titles with ANSI-aware utilities;
- wrap every interior row with the colored side rails and minimal padding;
- request the one-cell overlay margin;
- keep the existing row, selection, and help styling.

### Picker controller, list, preview, search, and actions

These modules retain their current behavior and interfaces unless a small type adjustment is required to pass layout metadata. They must not take responsibility for terminal framing or theme selection.

## Interaction and Data Flow

1. `/snip` collects copy items as it does now.
2. The picker controller manages filtering and selection as it does now.
3. The list and preview modules provide the selected content as they do now.
4. The layout module assigns rows within the current terminal height.
5. The UI module applies the full frame, centered titles, semantic colors, and final ANSI-safe width handling.
6. Existing copy, insert, cancel, navigation, and paging inputs remain unchanged.

## Error and Edge Cases

- Empty search results keep the full frame, filter, warning text, and cancel help.
- Long dialog or preview titles truncate symmetrically enough to preserve a valid frame.
- Long commands wrap or truncate according to the existing preview behavior without crossing the side rails.
- Terminal resize recalculates margins, frame width, centering, list height, and preview height without changing the selected item.
- Theme changes rebuild styled frame content so cached ANSI values do not retain the old theme.
- Very narrow terminals may drop outer margins. If the preview and its padding cannot fit, omit the preview instead of removing its padding. Every line must remain within the supplied width.

## Verification

Automated tests should cover reusable layout behavior:

- every framed line stays within the supplied width;
- the dialog title and preview title are centered using visible width;
- the selected result and help row remain visible across supported heights;
- the list-to-preview gap and preview content padding appear when space allows;
- preview decoration is removed before required interaction rows on short terminals;
- filtering, paging, and resizing do not change the copy target;
- empty results remain framed and have no selected action.

Do not add tests that only assert static theme-role names or fixed color values. Verify the semantic color mapping and the final appearance directly in Pi with the active theme. Run the existing `snip-actions` test suite and Pi's runtime extension-load check before completion.

## Acceptance Criteria

- The `/snip` overlay has a complete, bright outer frame.
- The main dialog title is centered in the top frame.
- The stacked layout preserves near-full-width command previews.
- When the preview is visible, a blank row separates the result list from its boundary.
- The preview title is centered in a distinct top separator.
- When the preview is visible, its content has a blank row above and below it.
- The preview's top and bottom separators use a different semantic color from the outer frame.
- The help row remains inside the dialog frame.
- Existing `/snip` search, navigation, paging, copy, insert, cancel, empty-result, resize, and theme-change behavior continues to work.
