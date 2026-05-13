# Gitea Authentication Guide

This document covers all authentication methods for `tea`, including multi-instance management and environment variables.

## Quick Setup

The fastest way to add a login:

```bash
# Token-based (recommended)
tea logins add --name myinstance --url https://gitea.example.com --token YOUR_TOKEN

# OAuth2 (browser-based, simpler)
tea logins add --name myinstance --url https://gitea.example.com --oauth
```

## Authentication Methods

### 1. Application Token (Recommended)

Generate a token in Gitea web UI: **Settings > Applications > Generate New Token**.

Required token scopes depend on operations:
- **read/write:issue** - Issues, comments
- **read/write:repository** - Repos, branches, releases
- **read/write:user** - User profile, notifications
- **read/write:organization** - Org management
- **read/write:admin** - Admin operations

```bash
tea logins add \
  --name work-gitea \
  --url https://gitea.company.com \
  --token ghp_xxxxxxxxxxxxxxxxxxxx \
  --scopes "read:issue,write:issue,read:repository,write:repository"
```

### 2. OAuth2 (Browser Flow)

Opens a browser for authentication. Simpler but may not work on headless systems.

```bash
tea logins add --name myinstance --url https://gitea.example.com --oauth
```

Custom OAuth client:
```bash
tea logins add \
  --name myinstance \
  --url https://gitea.example.com \
  --oauth \
  --client-id your-client-id \
  --redirect-url http://localhost:8080/callback
```

Refresh an expired OAuth token:
```bash
tea logins oauth-refresh myinstance
```

### 3. Basic Auth (Username/Password)

Tea creates a token from credentials automatically.

```bash
tea logins add \
  --name myinstance \
  --url https://gitea.example.com \
  --user myuser \
  --password mypassword
```

With 2FA/OTP:
```bash
tea logins add \
  --name myinstance \
  --url https://gitea.example.com \
  --user myuser \
  --password mypassword \
  --otp 123456
```

### 4. SSH Key Authentication

```bash
# Specify key file
tea logins add \
  --name myinstance \
  --url https://gitea.example.com \
  --token YOUR_TOKEN \
  --ssh-key ~/.ssh/id_ed25519

# Use ssh-agent
tea logins add \
  --name myinstance \
  --url https://gitea.example.com \
  --token YOUR_TOKEN \
  --ssh-agent-key "SHA256:xxxxx"

# SSH certificate
tea logins add \
  --name myinstance \
  --url https://gitea.example.com \
  --token YOUR_TOKEN \
  --ssh-agent-principal myuser
```

## All `tea logins add` Flags

| Flag | Alias | Env Var | Description |
|------|-------|---------|-------------|
| `--name` | `-n` | | Login name (for reference) |
| `--url` | `-u` | `$GITEA_SERVER_URL` | Server URL (default: `https://gitea.com`) |
| `--token` | `-t` | `$GITEA_SERVER_TOKEN` | Access token |
| `--user` | | `$GITEA_SERVER_USER` | Username for basic auth |
| `--password` | `--pwd` | `$GITEA_SERVER_PASSWORD` | Password for basic auth |
| `--otp` | | `$GITEA_SERVER_OTP` | OTP/2FA token |
| `--scopes` | | `$GITEA_SCOPES` | Token scopes (comma-separated) |
| `--ssh-key` | `-s` | | SSH private key path |
| `--ssh-agent-key` | `-a` | | SSH pubkey fingerprint (needs ssh-agent) |
| `--ssh-agent-principal` | `-c` | | SSH certificate principal |
| `--insecure` | `-i` | | Skip TLS certificate verification |
| `--no-version-check` | `--nv` | | Skip Gitea version check |
| `--oauth` | `-o` | | Use OAuth2 browser flow |
| `--client-id` | | | Custom OAuth2 client ID |
| `--redirect-url` | | | Custom OAuth2 redirect URL |

## Environment Variables

Set these to avoid passing flags repeatedly:

```bash
export GITEA_SERVER_URL="https://gitea.example.com"
export GITEA_SERVER_TOKEN="your-token-here"
```

| Variable | Description |
|----------|-------------|
| `GITEA_SERVER_URL` | Default server URL |
| `GITEA_SERVER_TOKEN` | Default access token |
| `GITEA_SERVER_USER` | Default username |
| `GITEA_SERVER_PASSWORD` | Default password |
| `GITEA_SERVER_OTP` | Default OTP token |
| `GITEA_SCOPES` | Default token scopes |
| `XDG_CONFIG_HOME` | Config directory (default: `~/.config`) |

## Configuration File

Location: `$XDG_CONFIG_HOME/tea/config.yml` (typically `~/.config/tea/config.yml`).
Legacy fallback: `~/.tea/tea.yml`.

### Structure

```yaml
logins:
  - name: "work"
    url: "https://gitea.company.com"
    token: "your_token"
    default: true
    ssh_host: "git.company.com"
    ssh_key: "/path/to/key"
    insecure: false
    user: "username"
    created: 1234567890

  - name: "personal"
    url: "https://gitea.example.com"
    token: "other_token"
    default: false
    user: "myuser"

preferences:
  editor: false
  flag_defaults:
    remote: "upstream"
```

## Multi-Instance Management

### Setting up multiple Gitea instances

```bash
# Add work instance
tea logins add --name work --url https://gitea.company.com --token TOKEN1

# Add personal instance
tea logins add --name personal --url https://gitea.example.com --token TOKEN2

# Add open-source instance (gitea.com)
tea logins add --name oss --url https://gitea.com --token TOKEN3
```

### Switching between instances

```bash
# Set default login
tea logins default work

# Use specific login for a command
tea repos ls --login personal

# List all configured logins
tea logins ls
```

### Context-based auto-detection

When inside a git repository, `tea` checks git remotes against configured login URLs. If a remote matches a login, that login is used automatically.

```bash
# Use a specific remote for detection
tea issues ls --remote upstream

# Override with explicit repo
tea issues ls --login work --repo myorg/myrepo
```

### Preferences

Configure default behavior in `config.yml`:

```yaml
preferences:
  editor: false          # true = open external editor for multiline input
  flag_defaults:
    remote: "upstream"   # prefer 'upstream' remote for auto-detection
```

## Verifying Authentication

```bash
# Check current user
tea whoami

# List logins with details
tea logins ls --output yaml

# Test API access
tea api /user
```

## Self-Signed Certificates

For Gitea instances with self-signed TLS certificates:

```bash
tea logins add --name internal --url https://gitea.internal --token TOKEN --insecure
```

## Logout

```bash
tea logout    # remove current login
```

## Troubleshooting Authentication

### "401 Unauthorized"
- Token may be expired or revoked
- Regenerate in Gitea web UI: Settings > Applications
- Update with `tea logins edit`

### "403 Forbidden"
- Token lacks required scopes
- Regenerate with broader scopes

### OAuth token expired
```bash
tea logins oauth-refresh myinstance
```

### Wrong instance detected
- Check `git remote -v` output
- Use `--login name` to force a specific instance
- Set `preferences.flag_defaults.remote` in config
