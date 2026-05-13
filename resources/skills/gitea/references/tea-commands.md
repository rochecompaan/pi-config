# Tea CLI Complete Command Reference

This document provides the complete flag and option reference for every `tea` subcommand. Consult this when you need exact flag names, aliases, or default values.

## Global Flags

These flags are available on ALL commands:

| Flag | Alias | Description |
|------|-------|-------------|
| `--debug` | `--vvv` | Enable debug output |
| `--help` | `-h` | Show help |
| `--version` | `-v` | Print version |

## Repository Context Flags

Available on most entity commands (issues, pulls, labels, etc.):

| Flag | Alias | Description |
|------|-------|-------------|
| `--repo` | `-r` | Override repository (owner/repo slug or local path) |
| `--remote` | `-R` | Discover Gitea login from this git remote name |
| `--login` | `-l` | Use a specific Gitea login by name |

## Output Flags

Available on list/detail commands:

| Flag | Alias | Description | Default |
|------|-------|-------------|---------|
| `--output` | `-o` | Format: `simple`, `table`, `csv`, `tsv`, `yaml`, `json` | `table` |
| `--fields` | `-f` | Comma-separated list of fields to display | varies |

## Pagination Flags

Available on list commands:

| Flag | Alias | Description | Default |
|------|-------|-------------|---------|
| `--page` | `-p` | Page number | 1 |
| `--limit` | `--lm` | Items per page | 30 |

---

## Issues (`tea issues` / `tea issue` / `tea i`)

### `tea issues list` (alias: `ls`)

| Flag | Alias | Description |
|------|-------|-------------|
| `--state` | | `open`, `closed`, `all` (default: `open`) |
| `--kind` | `-K` | `issues`, `pulls`, `all` |
| `--keyword` | `-k` | Search string |
| `--labels` | `-L` | Comma-separated label names |
| `--milestones` | `-m` | Comma-separated milestone names |
| `--author` | `-A` | Filter by author username |
| `--assignee` | `-a` | Filter by assignee username |
| `--mentions` | `-M` | Filter by mentioned username |
| `--from` | `-F` | Activity after date (ISO 8601) |
| `--until` | `-u` | Activity before date (ISO 8601) |
| `--comments` | | Display comments |

### `tea issues create` (alias: `c`)

| Flag | Alias | Description |
|------|-------|-------------|
| `--title` | `-t` | Issue title (required) |
| `--description` | `-d` | Issue body |
| `--assignees` | `-a` | Comma-separated usernames |
| `--labels` | `-L` | Comma-separated labels |
| `--milestone` | `-m` | Milestone name |
| `--deadline` | `-D` | Deadline (ISO 8601 timestamp) |
| `--referenced-version` | `-v` | Commit hash or tag name |

### `tea issues edit` (alias: `e`)

Takes issue index as argument.

| Flag | Alias | Description |
|------|-------|-------------|
| `--title` | `-t` | New title |
| `--description` | `-d` | New description |
| `--add-assignees` | `-a` | Add assignees |
| `--add-labels` | `-L` | Add labels (takes precedence over remove) |
| `--remove-labels` | | Remove labels |
| `--milestone` | `-m` | Change milestone (empty string to unset) |
| `--deadline` | `-D` | Change deadline |

### `tea issues close`

Takes one or more issue indices as arguments.

### `tea issues reopen` (alias: `open`)

Takes one or more issue indices as arguments.

---

## Pull Requests (`tea pulls` / `tea pull` / `tea pr`)

### `tea pulls list` (alias: `ls`)

Same filtering flags as `tea issues list`.

### `tea pulls create` (alias: `c`)

| Flag | Alias | Description |
|------|-------|-------------|
| `--title` | `-t` | PR title (required) |
| `--description` | `-d` | PR body |
| `--base` | `-b` | Target branch (default: repo default branch) |
| `--head` | | Source branch (`user:branch` for fork PRs) |
| `--assignees` | `-a` | Comma-separated usernames |
| `--labels` | `-L` | Comma-separated labels |
| `--milestone` | `-m` | Milestone name |
| `--deadline` | `-D` | Deadline |
| `--allow-maintainer-edits` | | Allow maintainers to push to head branch |

### `tea pulls checkout` (alias: `co`)

Takes PR index as argument.

| Flag | Alias | Description |
|------|-------|-------------|
| `--branch` | `-b` | Create local branch with this name |

### `tea pulls review`

Interactive review of a PR. Takes PR index as argument.

### `tea pulls approve` (aliases: `lgtm`, `a`)

Approve a PR. Takes PR index as argument.

### `tea pulls reject`

Request changes on a PR. Takes PR index as argument.

### `tea pulls merge` (alias: `m`)

| Flag | Alias | Description |
|------|-------|-------------|
| `--style` | `-s` | `merge`, `rebase`, `squash`, `rebase-merge` |
| `--title` | `-t` | Merge commit title |
| `--message` | `-m` | Merge commit message |

### `tea pulls clean`

Delete local and remote branches for a merged/closed PR. Takes PR index as argument.

### `tea pulls close` / `tea pulls reopen`

Takes one or more PR indices as arguments.

---

## Repositories (`tea repos` / `tea repo`)

### `tea repos list` (alias: `ls`)

Standard output and pagination flags.

| Flag | Alias | Description |
|------|-------|-------------|
| `--type` | `-T` | `fork`, `mirror`, `source` |

### `tea repos search` (alias: `s`)

Takes search query as argument.

| Flag | Alias | Description |
|------|-------|-------------|
| `--topic` | `-t` | Search in repo topics instead of name |
| `--type` | `-T` | `fork`, `mirror`, `source` |
| `--owner` | `-O` | Filter by owner |
| `--private` | | Filter private repos (`true`/`false`) |
| `--archived` | | Filter archived repos (`true`/`false`) |

### `tea repos create` (alias: `c`)

| Flag | Alias | Description |
|------|-------|-------------|
| `--name` | | Repository name (required) |
| `--owner` | `-O` | Owner (user or org, default: authenticated user) |
| `--private` | | Make repository private |
| `--description` | `--desc` | Repository description |
| `--init` | | Initialize repository |
| `--labels` | | Label set to add |
| `--gitignores` | `--git` | Gitignore templates (requires `--init`) |
| `--license` | | License template (requires `--init`) |
| `--readme` | | Readme template (requires `--init`) |
| `--branch` | | Default branch name (requires `--init`) |
| `--template` | | Make repo a template |
| `--trustmodel` | | `committer`, `collaborator`, `collaborator+committer` |
| `--object-format` | | `sha1`, `sha256` |

### `tea repos create-from-template` (alias: `ct`)

Same flags as `create`, uses a template repository.

### `tea repos fork` (alias: `f`)

Takes `owner/repo` as argument.

| Flag | Alias | Description |
|------|-------|-------------|
| `--owner` | `-O` | Fork to this owner (default: authenticated user) |

### `tea repos migrate` (alias: `m`)

| Flag | Alias | Description |
|------|-------|-------------|
| `--name` | | Repository name |
| `--owner` | | Owner |
| `--clone-url` | | Source clone URL |
| `--service` | | `git`, `gitea`, `gitlab`, `gogs` |
| `--mirror` | | Create as mirror |
| `--private` | | Make private |
| `--wiki` | | Copy wiki |
| `--issues` | | Copy issues |
| `--labels` | | Copy labels |
| `--pull-requests` | | Copy PRs |
| `--releases` | | Copy releases |
| `--milestones` | | Copy milestones |
| `--lfs` | | Copy LFS objects |
| `--lfs-endpoint` | | LFS endpoint URL |
| `--auth-user` | | Auth username for source |
| `--auth-password` | | Auth password for source |
| `--auth-token` | | Auth token for source |
| `--mirror-interval` | | Mirror sync interval (e.g., `8h`) |

### `tea repos delete` (alias: `rm`)

Destructive. Uses `--repo` flag to specify target.

---

## Releases (`tea releases` / `tea release` / `tea r`)

### `tea releases list` (alias: `ls`)

Standard output and pagination flags.

### `tea releases create` (alias: `c`)

| Flag | Alias | Description |
|------|-------|-------------|
| `--tag` | | Tag name (creates if doesn't exist) |
| `--target` | | Target branch/commit (default: default branch) |
| `--title` | `-t` | Release title |
| `--note` | `-n` | Release notes |
| `--note-file` | `-f` | Release notes from file (overrides `--note`) |
| `--draft` | `-d` | Mark as draft |
| `--prerelease` | `-p` | Mark as pre-release |
| `--asset` | `-a` | File attachment (repeatable) |

### `tea releases edit` (alias: `e`)

Takes release ID as argument.

| Flag | Alias | Description |
|------|-------|-------------|
| `--tag` | | Change tag |
| `--target` | | Change target |
| `--title` | `-t` | Change title |
| `--note` | `-n` | Change notes |
| `--draft` | `-d` | Mark as draft (`True`/`false`) |
| `--prerelease` | `-p` | Mark as pre-release (`True`/`false`) |

### `tea releases delete` (alias: `rm`)

Takes one or more release IDs as arguments.

### `tea releases assets` (alias: `asset`, `a`)

- `tea releases assets ls <release-id>` - List assets
- `tea releases assets create <release-id> <file>` - Upload asset
- `tea releases assets delete <release-id> <asset-id>` - Delete asset

---

## Labels (`tea labels` / `tea label`)

### `tea labels list` (alias: `ls`)

Standard output flags.

### `tea labels create` (alias: `c`)

| Flag | Alias | Description |
|------|-------|-------------|
| `--name` | | Label name (required) |
| `--color` | | Hex color (e.g., `#ff0000`) |
| `--description` | | Label description |

### `tea labels update`

Takes label ID as argument. Same flags as create.

### `tea labels delete` (alias: `rm`)

Takes label ID as argument.

---

## Milestones (`tea milestones` / `tea milestone` / `tea ms`)

### `tea milestones list` (alias: `ls`)

Standard output and pagination flags.

### `tea milestones create` (alias: `c`)

| Flag | Alias | Description |
|------|-------|-------------|
| `--title` | | Milestone title (required) |
| `--description` | | Description |
| `--deadline` | | Deadline (ISO 8601) |

### `tea milestones close`

Takes milestone ID as argument.

### `tea milestones reopen` (alias: `open`)

Takes milestone ID as argument.

### `tea milestones delete` (alias: `rm`)

Takes milestone ID as argument.

### `tea milestones issues` (alias: `i`)

List issues/PRs in a milestone. Takes milestone ID as argument.

---

## Time Tracking (`tea times` / `tea time` / `tea t`)

### `tea times list` (alias: `ls`)

Lists tracked time. Takes optional issue index.

### `tea times add` (alias: `a`)

`tea times add <issue-index> <duration>`

Duration format: `1h30m`, `2h`, `45m`, etc.

### `tea times delete` (alias: `rm`)

`tea times delete <issue-index> <time-id>`

### `tea times reset`

`tea times reset <issue-index>` - Reset all tracked time on an issue.

---

## Actions (`tea actions` / `tea action`)

### Secrets (`tea actions secrets` / `secret`)

- `tea actions secrets ls` - List secrets
- `tea actions secrets create <name> [value]` - Create secret
  - `--file` - Read value from file
  - `--stdin` - Read value from stdin
- `tea actions secrets delete <name>` - Delete secret

### Variables (`tea actions variables` / `variable` / `vars` / `var`)

- `tea actions variables ls` - List variables
- `tea actions variables set <name> [value]` - Set variable
  - `--file` - Read value from file
  - `--stdin` - Read value from stdin
- `tea actions variables delete <name>` - Delete variable

### Runs (`tea actions runs` / `run`)

- `tea actions runs ls` - List workflow runs
- `tea actions runs view <run-id>` - View run details
- `tea actions runs logs <run-id>` - View logs
  - `--job` - Specific job ID
  - `--follow` / `-f` - Follow log output
- `tea actions runs delete <run-id>` - Delete run

### Workflows (`tea actions workflows` / `workflow`)

- `tea actions workflows ls` - List workflows

---

## Webhooks (`tea webhooks` / `tea webhook` / `tea hooks` / `tea hook`)

### `tea webhooks list` (alias: `ls`)

Standard output flags.

### `tea webhooks create` (alias: `c`)

| Flag | Alias | Description |
|------|-------|-------------|
| `--url` | | Webhook URL (first argument) |
| `--type` | | `gitea`, `gogs`, `slack`, `discord`, `dingtalk`, `telegram`, `msteams`, `feishu`, `wechatwork`, `packagist` |
| `--secret` | | Webhook secret |
| `--events` | | Comma-separated events (default: `push`) |
| `--active` | | Webhook is active |
| `--branch-filter` | | Branch filter for push events |
| `--authorization-header` | | Authorization header value |

### `tea webhooks update` (aliases: `edit`, `u`)

Takes webhook ID as argument.

| Flag | Alias | Description |
|------|-------|-------------|
| `--url` | | New webhook URL |
| `--secret` | | New secret |
| `--events` | | New events |
| `--active` | | Mark active |
| `--inactive` | | Mark inactive |
| `--branch-filter` | | Branch filter |
| `--authorization-header` | | Authorization header |

### `tea webhooks delete` (alias: `rm`)

Takes webhook ID as argument.

---

## Organizations (`tea organizations` / `tea organization` / `tea org`)

### `tea orgs list` (alias: `ls`)

Standard output flags.

### `tea orgs create` (alias: `c`)

| Flag | Alias | Description |
|------|-------|-------------|
| `--name` | `-n` | Organization name |
| `--description` | `-d` | Description |
| `--website` | `-w` | Website URL |
| `--location` | `-L` | Location |
| `--visibility` | `-v` | Visibility |
| `--repo-admins-can-change-team-access` | | Allow repo admins to change team access |

### `tea orgs delete` (alias: `rm`)

Takes org name as argument. Destructive.

---

## Branches (`tea branches` / `tea branch` / `tea b`)

### `tea branches list` (alias: `ls`)

Standard output flags.

### `tea branches protect` (alias: `P`)

Protect a branch. Takes branch name as argument.

### `tea branches unprotect` (alias: `U`)

Unprotect a branch. Takes branch name as argument.

---

## Notifications (`tea notifications` / `tea notification` / `tea n`)

### `tea notifications list` (alias: `ls`)

| Flag | Alias | Description |
|------|-------|-------------|
| `--types` | `-t` | `issue`, `pull`, `repository`, `commit` (comma-separated) |
| `--states` | `-s` | `pinned`, `unread`, `read` (default: `unread,pinned`) |
| `--mine` | `-m` | Show across all repos (not just current) |

### `tea notifications read` (alias: `r`)

Mark notification as read. Takes notification ID.

### `tea notifications unread` (alias: `u`)

Mark notification as unread. Takes notification ID.

### `tea notifications pin` (alias: `p`)

Pin a notification. Takes notification ID.

### `tea notifications unpin`

Unpin a notification. Takes notification ID.

---

## Logins (`tea logins` / `tea login`)

### `tea logins list` (alias: `ls`)

Standard output flags.

### `tea logins add`

See `references/authentication.md` for complete flag reference.

### `tea logins edit` (alias: `e`)

Edit an existing login configuration.

### `tea logins delete` (alias: `rm`)

Delete a login. Takes login name as argument.

### `tea logins default`

Get or set the default login. Takes optional login name.

---

## Other Commands

| Command | Alias | Description |
|---------|-------|-------------|
| `tea clone <repo>` | `C` | Clone a repository |
| `tea open` | `o` | Open repo/issue/PR in web browser |
| `tea whoami` | | Show current logged-in user |
| `tea comment <index> <body>` | `c` | Add comment to issue/PR |
| `tea admin users ls` | | List all users (admin only) |
| `tea api <endpoint>` | | Make authenticated API requests |

### `tea api` flags

| Flag | Alias | Description |
|------|-------|-------------|
| `--method` | `-X` | HTTP method: `GET`, `POST`, `PUT`, `PATCH`, `DELETE` |
| `--field` | `-f` | String field: `key=value` (repeatable) |
| `--Field` | `-F` | Typed field: `key=value`, `@file`, `@-` (stdin) |
| `--header` | `-H` | Custom header: `key:value` (repeatable) |
| `--include` | `-i` | Include HTTP status and headers in output |
| `--output` | `-o` | Write response to file (`-` for stdout) |

### `tea clone` flags

| Flag | Alias | Description |
|------|-------|-------------|
| `--depth` | `-d` | Number of commits to fetch (0 = all) |
| `--login` | `-l` | Use specific login instance |

Supports slug formats: `owner/repo`, `repo`, `gitea.com/owner/repo`, `git@gitea.com:owner/repo`, `https://gitea.com/owner/repo`, `ssh://gitea.com:22/owner/repo`.
