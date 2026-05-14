---
name: linear
description: Manage Linear issues via the local streamlinear-cli wrapper. Use when the user asks to search Linear issues, inspect a ticket, change status, priority, or assignee, add comments, create issues, list teams and workflow states, or run GraphQL queries against Linear.
compatibility: Requires streamlinear-cli on PATH and a Linear API token available via ~/.config/streamlinear/token (managed by sops-nix in this setup) or LINEAR_API_TOKEN.
---

# Linear

Use the local `streamlinear-cli` wrapper for Linear work.

## Before you start

- Never print or expose the API token.
- If you need to discover available teams or workflow states first, run:

```bash
streamlinear-cli teams
```

- IDs can be provided as:
  - short IDs like `ABC-123`
  - full Linear issue URLs
  - UUIDs

## Search issues

```bash
# Default: your active issues
streamlinear-cli search

# Text search
streamlinear-cli search "auth bug"

# Filter by state
streamlinear-cli search --state "In Progress"

# Filter by assignee
streamlinear-cli search --assignee me
streamlinear-cli search --assignee user@example.com

# Filter by team
streamlinear-cli search --team ENG

# Combine filters
streamlinear-cli search --state "In Progress" --assignee me --team ENG
```

## Get issue details

```bash
streamlinear-cli get ABC-123
streamlinear-cli get "https://linear.app/acme/issue/ABC-123"
```

## Update an issue

```bash
# State
streamlinear-cli update ABC-123 --state Done
streamlinear-cli update ABC-123 --state "In Progress"

# Priority: 1=Urgent, 2=High, 3=Medium, 4=Low
streamlinear-cli update ABC-123 --priority 1

# Assignee
streamlinear-cli update ABC-123 --assignee me
streamlinear-cli update ABC-123 --assignee user@example.com
streamlinear-cli update ABC-123 --assignee null

# Multiple changes at once
streamlinear-cli update ABC-123 --state Done --priority 3
```

## Comment on an issue

```bash
streamlinear-cli comment ABC-123 "Fixed in commit abc123"
streamlinear-cli comment ABC-123 "Blocked on dependency update"
```

## Create an issue

```bash
# Basic
streamlinear-cli create --team ENG --title "Bug: Login fails"

# With description
streamlinear-cli create --team ENG --title "Bug: Login fails" --body "Users see an error on submit"

# With priority
streamlinear-cli create --team ENG --title "Urgent fix" --priority 1
```

## Raw GraphQL

Use this only when the standard actions are not enough.

```bash
streamlinear-cli graphql "query { viewer { name email } }"
streamlinear-cli graphql "query { projects { nodes { id name } } }"
```

## Working pattern

1. Discover teams/states when unclear with `streamlinear-cli teams`
2. Search first when the user refers to an issue vaguely
3. Use `get` before mutating when you need confirmation about current state
4. Prefer targeted commands (`search`, `get`, `update`, `comment`, `create`) over raw GraphQL
5. Use GraphQL only for unsupported or highly specific queries
