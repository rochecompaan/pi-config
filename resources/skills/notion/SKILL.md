---
name: notion
description: Use when the user asks to create, read, update, append to, archive, restore, move, or otherwise manage Notion pages via the Notion API.
compatibility: Requires the 4ier/notion-cli `notion` binary on PATH and either NOTION_TOKEN or a configured `notion auth login --with-token` profile. Notion page deletion is soft-delete/archive unless explicitly restored later.
---

# Notion Page CRUD

Use the `notion` CLI from `4ier/notion-cli` for basic Notion page operations. Prefer precise, reversible changes, search before mutating when targets are ambiguous, and never expose Notion tokens.

## Before You Start

1. Check that the 4ier Notion CLI exists:

```bash
command -v notion
```

2. Check authentication without printing secrets:

```bash
notion auth status --format json
notion auth doctor --format json
```

If auth is missing, tell the user to run one of these outside chat:

```bash
notion auth login --with-token
# or
export NOTION_TOKEN=ntn_xxxxx
```

Do not ask the user to paste a Notion token into chat.

## Operating Rules

- Use `--format json` for machine-readable operations.
- Commands accept either Notion IDs or Notion URLs; URLs are often safer when copied from the browser.
- Search or inspect first when the page, parent, or database is ambiguous.
- Ask for confirmation before archiving/deleting pages, deleting blocks, moving pages, or replacing substantial page content.
- Do not dump raw JSON to the user unless they ask for it; summarize titles, IDs, URLs, and key fields.
- Treat `notion page archive`, `notion page trash`, and `notion page delete` as soft-delete/archive. Use `notion page restore` to undo.
- Prefer dedicated commands over `notion api` for normal CRUD.

## Find Pages

Use search when the user gives a title, topic, or vague description instead of an exact ID/URL:

```bash
notion search "project roadmap" --type page --limit 10 --format json
```

If several pages match, present the best matches and ask the user to choose before mutating.

List pages when browsing is more appropriate than keyword search:

```bash
notion page list --format json
notion page list <parent_page_id_or_url> --format json
```

## Read Page

View a page and its content:

```bash
notion page view <page_id_or_url> --format json
```

Get page properties:

```bash
notion page props <page_id_or_url> --format json
notion page props <page_id_or_url> <property_id> --format json
```

Fetch a single property by display name when relation/rollup values might be paginated or truncated:

```bash
notion page property <page_id_or_url> --name "References" --format json
```

Export full-page Markdown when the user wants readable content:

```bash
notion page markdown <page_id_or_url>
notion page markdown <page_id_or_url> --out /tmp/notion-page.md
notion page markdown <page_id_or_url> --format json
```

List child blocks when you need block IDs or sub-block structure:

```bash
notion block list <page_id_or_block_id_or_url> --depth 3 --format json
notion block list <page_id_or_block_id_or_url> --depth 3 --md
```

## Create Page

Create a child page under an existing page:

```bash
notion page create <parent_page_id_or_url> \
  --title "New Page Title" \
  --body "Initial page content" \
  --format json
```

Create a database row/page in a database. Use `--db` so the CLI resolves property types from the database schema:

```bash
notion page create <database_id_or_url> \
  --db \
  "Name=Weekly Review" \
  "Status=Todo" \
  "Date=2026-03-01" \
  --format json
```

For database-backed pages, inspect the database schema first when property names or types are unclear:

```bash
notion db view <database_id_or_url> --format json
```

After creation, report the page title, parent/database, URL, and ID.

## Update Page Properties

Inspect current properties before changing them unless the user provides an exact page ID/URL and exact property changes:

```bash
notion page props <page_id_or_url> --format json
```

Set one or more properties with schema-aware `key=value` arguments:

```bash
notion page set <page_id_or_url> \
  "Status=Done" \
  "Priority=High" \
  --format json
```

Use `notion page link` and `notion page unlink` for relation properties instead of manually constructing relation JSON:

```bash
notion page link <page_id_or_url> --prop "Related" --to <target_page_id_or_url> --format json
notion page unlink <page_id_or_url> --prop "Related" --from <target_page_id_or_url> --format json
```

## Append or Replace Page Content

For additive updates, prefer Markdown append:

```bash
notion page set-markdown <page_id_or_url> \
  --append \
  --text "\n\nNew note content" \
  --format json
```

For longer content, write Markdown to a temp file and append it:

```bash
cat > /tmp/notion-append.md <<'EOF'
## New Section

- First point
- Second point
EOF

notion page set-markdown <page_id_or_url> \
  --append \
  --file /tmp/notion-append.md \
  --format json
```

To append one simple block, `block append` is also appropriate:

```bash
notion block append <page_id_or_block_id_or_url> "New paragraph" --format json
notion block append <page_id_or_block_id_or_url> --type bullet "New bullet" --format json
notion block append <page_id_or_block_id_or_url> --file /tmp/notion-append.md --format json
```

Replacing page content is destructive. Confirm first, then use:

```bash
notion page set-markdown <page_id_or_url> \
  --file /tmp/new-page.md \
  --format json
```

Use `--allow-deleting-content` only when the user explicitly agrees that child pages/databases may be removed during replacement.

## Update or Delete Blocks

List blocks first so you have exact block IDs:

```bash
notion block list <page_id_or_url> --depth 3 --format json
```

Update one block in place:

```bash
notion block update <block_id_or_url> --text "Updated text" --format json
notion block update <block_id_or_url> --text "Updated **markdown**" --markdown --format json
```

Delete blocks only after confirmation:

```bash
notion block delete <block_id_or_url> --format json
```

## Archive, Restore, or Move Page

Before archiving or moving, confirm the exact page title and ID/URL with the user:

```bash
notion page view <page_id_or_url> --format json
```

Archive/soft-delete:

```bash
notion page archive <page_id_or_url> --format json
```

Restore an archived page:

```bash
notion page restore <page_id_or_url> --format json
```

Move a page to a new parent:

```bash
notion page move <page_id_or_url> --to <new_parent_id_or_url> --format json
```

Tell the user that archive/delete is reversible soft-delete, not permanent deletion.

## Raw API Escape Hatch

Use `notion api` only when a dedicated command is not available:

```bash
notion api GET /v1/users/me --format json
notion api POST /v1/search --body '{"query":"weekly planning","page_size":5}' --format json
notion api PATCH /v1/pages/<page_id> --body @/tmp/body.json --format json
```

Prefer dedicated commands over raw API calls for normal page CRUD.

## Response Pattern

After each operation, answer with:

- What action was performed.
- The page title.
- The page ID and URL when available.
- Any assumptions or skipped fields.
- Whether the operation was create, read, update, append, replace, archive, restore, or move.

## Common Mistakes

- **Using `notion-cli` instead of `notion`:** 4ier/notion-cli installs the `notion` binary.
- **Printing tokens:** Never echo token values or include them in command output.
- **Mutating the wrong page:** Search and ask the user to choose when matches are ambiguous.
- **Calling archive “permanent delete”:** Explain that Notion page delete/archive is reversible soft-delete.
- **Replacing content accidentally:** Prefer append. Confirm before `page set-markdown` replacement.
- **Dumping JSON:** Summarize JSON for humans unless raw output is requested.
- **Guessing database properties:** Inspect with `notion db view` before creating/updating database-backed pages.
