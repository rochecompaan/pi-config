# Advanced Gitea Workflows

This document covers complex multi-step workflows, `tea api` patterns, and bulk operations.

## Fork-Based Contribution Workflow

Complete workflow for contributing to a project via fork:

```bash
# 1. Fork the repository
tea repos fork upstream-org/project

# 2. Clone your fork
tea clone myuser/project
cd project

# 3. Add upstream remote
git remote add upstream $(tea api /repos/upstream-org/project --output - | python3 -c "import sys,json; print(json.load(sys.stdin)['clone_url'])")

# 4. Create feature branch
git checkout -b feature/my-change

# 5. Make changes, commit
git add -A && git commit -m "feat: add new feature"

# 6. Push to your fork
git push origin feature/my-change

# 7. Create PR against upstream
tea pulls create \
  --title "feat: add new feature" \
  --description "## Summary\nAdds X feature\n\n## Testing\n- Tested locally" \
  --base main \
  --head myuser:feature/my-change \
  --repo upstream-org/project
```

## Release Workflow with Assets

Full release process including changelog and binary assets:

```bash
# 1. List recent commits since last tag for changelog context
git log $(git describe --tags --abbrev=0)..HEAD --oneline

# 2. Create the release with assets
tea releases create \
  --tag v2.0.0 \
  --title "v2.0.0 - Major Release" \
  --note-file CHANGELOG.md \
  --target main \
  --asset ./dist/app-linux-amd64 \
  --asset ./dist/app-darwin-amd64 \
  --asset ./dist/app-windows-amd64.exe

# 3. Verify the release
tea releases ls --output json | head -20
```

## Sprint Planning Workflow

Set up milestones, labels, and issues for a sprint:

```bash
# 1. Create milestone
tea milestones create --title "Sprint 23" --description "March 15-29" --deadline 2025-03-29

# 2. Create priority labels (if not existing)
tea labels create --name "priority:critical" --color "#dc3545"
tea labels create --name "priority:high" --color "#fd7e14"
tea labels create --name "priority:medium" --color "#ffc107"
tea labels create --name "priority:low" --color "#28a745"

# 3. Create sprint issues
tea issues create --title "Implement auth flow" --labels "priority:high" --milestone "Sprint 23" --assignees alice
tea issues create --title "Fix pagination bug" --labels "priority:critical,bug" --milestone "Sprint 23" --assignees bob
tea issues create --title "Update API docs" --labels "priority:medium" --milestone "Sprint 23" --assignees carol

# 4. View sprint board
tea milestones issues "Sprint 23"
```

## PR Review Workflow

Structured code review process:

```bash
# 1. List PRs needing review
tea pulls ls --labels "needs-review" --output table

# 2. Checkout PR locally for testing
tea pulls checkout 42

# 3. Run tests locally (project-specific)
# make test / npm test / go test ./... etc.

# 4. Approve or request changes
tea pulls approve 42
# or
tea pulls reject 42

# 5. Merge after approval
tea pulls merge 42 --style squash --title "feat: implement feature X (#42)"

# 6. Clean up branches
tea pulls clean 42
```

## Bulk Operations

### Close multiple issues

```bash
tea issues close 10 11 12 13 14
```

### Bulk label management

```bash
# Add label to multiple issues
for i in 10 11 12; do
  tea issues edit $i --add-labels "sprint-23"
done

# Remove label from multiple issues
for i in 10 11 12; do
  tea issues edit $i --remove-labels "sprint-22"
done
```

### Bulk milestone assignment

```bash
for i in $(tea issues ls --state open --output simple --fields index | tail -n +2); do
  tea issues edit $i --milestone "Sprint 23"
done
```

## Direct API Access with `tea api`

The `tea api` command provides direct access to the Gitea API for operations not covered by dedicated subcommands.

### Endpoint format

```bash
tea api <endpoint>              # GET by default
tea api -X POST <endpoint>      # specify method
```

Placeholders `{owner}` and `{repo}` are auto-replaced from git context when inside a repository.

### Common API Operations

**Get repository details:**
```bash
tea api /repos/{owner}/{repo}
```

**List repository topics:**
```bash
tea api /repos/{owner}/{repo}/topics
```

**Add a topic:**
```bash
tea api -X PUT /repos/{owner}/{repo}/topics -f topic=devops
```

**List commits on a branch:**
```bash
tea api "/repos/{owner}/{repo}/commits?sha=main&limit=10"
```

**Get file content:**
```bash
tea api /repos/{owner}/{repo}/contents/README.md
```

**Create or update a file:**
```bash
tea api -X POST /repos/{owner}/{repo}/contents/path/to/file.txt \
  -F content="$(echo -n 'file content' | base64)" \
  -F message="Add file via API"
```

**List repository collaborators:**
```bash
tea api /repos/{owner}/{repo}/collaborators
```

**Add a collaborator:**
```bash
tea api -X PUT /repos/{owner}/{repo}/collaborators/username \
  -F permission=write
```

**List repo branches with protection status:**
```bash
tea api /repos/{owner}/{repo}/branches
```

**Get branch protection rules:**
```bash
tea api /repos/{owner}/{repo}/branch_protections
```

**Star a repository:**
```bash
tea api -X PUT /user/starred/{owner}/{repo}
```

**List user's starred repos:**
```bash
tea api /user/starred
```

**Get instance version:**
```bash
tea api /version
```

**Search users:**
```bash
tea api "/users/search?q=keyword"
```

**List teams in an org:**
```bash
tea api /orgs/myorg/teams
```

**Get PR diff:**
```bash
tea api /repos/{owner}/{repo}/pulls/42.diff
```

**Get PR merge status:**
```bash
tea api /repos/{owner}/{repo}/pulls/42
```

**List PR reviews:**
```bash
tea api /repos/{owner}/{repo}/pulls/42/reviews
```

**List PR files changed:**
```bash
tea api /repos/{owner}/{repo}/pulls/42/files
```

**Get issue comments:**
```bash
tea api /repos/{owner}/{repo}/issues/42/comments
```

**Create issue comment:**
```bash
tea api -X POST /repos/{owner}/{repo}/issues/42/comments \
  -F body="This looks good, merging."
```

**Add issue reaction:**
```bash
tea api -X POST /repos/{owner}/{repo}/issues/42/reactions \
  -F content="+1"
```

**List deploy keys:**
```bash
tea api /repos/{owner}/{repo}/keys
```

**Check CI/Actions status of a commit:**
```bash
tea api /repos/{owner}/{repo}/commits/COMMIT_SHA/statuses
```

### Handling Paginated Results

Most list endpoints support pagination:

```bash
# Page 2, 50 items per page
tea api "/repos/{owner}/{repo}/issues?page=2&limit=50&state=open"
```

### Saving API output

```bash
# Save to file
tea api /repos/{owner}/{repo} --output repo-info.json

# Include headers (useful for pagination)
tea api /repos/{owner}/{repo}/issues --include
```

### Typed Fields vs String Fields

```bash
# -f (lowercase) sends string values
tea api -X POST /endpoint -f name=value

# -F (uppercase) sends typed values and can read files
tea api -X POST /endpoint -F count=42           # integer
tea api -X POST /endpoint -F active=true        # boolean
tea api -X POST /endpoint -F data=@file.json    # file content
tea api -X POST /endpoint -F data=@-            # stdin
```

## Webhook Setup for CI/CD Integration

### Set up a push webhook for CI

```bash
tea webhooks create https://ci.example.com/webhook \
  --events push \
  --secret "webhook-secret-token" \
  --active \
  --branch-filter "main"
```

### Set up PR notification webhook

```bash
tea webhooks create https://slack.example.com/webhook \
  --type slack \
  --events pull_request,pull_request_review \
  --active
```

## Migration Workflows

### Mirror a GitHub repository

```bash
tea repos migrate \
  --name github-mirror \
  --clone-url https://github.com/org/repo.git \
  --service github \
  --mirror \
  --mirror-interval 1h \
  --auth-token ghp_xxxx \
  --issues --labels --pull-requests --releases --milestones --wiki
```

### Import from GitLab

```bash
tea repos migrate \
  --name from-gitlab \
  --clone-url https://gitlab.com/org/repo.git \
  --service gitlab \
  --auth-token glpat-xxxx \
  --issues --labels --milestones --releases
```

## Project Setup Workflow

Initialize a new project with full configuration:

```bash
# 1. Create repository
tea repos create \
  --name my-project \
  --owner my-org \
  --description "Project description" \
  --init \
  --gitignores Go \
  --license MIT \
  --readme Default \
  --branch main

# 2. Set up labels
tea labels create --name "type:bug" --color "#d73a4a" --description "Something isn't working"
tea labels create --name "type:feature" --color "#0075ca" --description "New feature request"
tea labels create --name "type:docs" --color "#0075ca" --description "Documentation"
tea labels create --name "status:in-progress" --color "#fbca04"
tea labels create --name "status:review" --color "#c5def5"

# 3. Set up milestones
tea milestones create --title "v1.0" --description "Initial release"

# 4. Protect main branch
tea branches protect main

# 5. Set up webhook
tea webhooks create https://ci.example.com/hook \
  --events push,pull_request \
  --secret mysecret

# 6. Clone locally
tea clone my-org/my-project
```

## Monitoring Workflow

Check project health and activity:

```bash
# Open issues by label
tea issues ls --state open --labels bug --output table

# PRs waiting for review
tea pulls ls --state open --output table

# Recent notifications
tea notifications ls --mine --output table

# CI/CD run status
tea actions runs ls --output table

# Time tracked this week
tea times ls --output table
```
