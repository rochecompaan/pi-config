# pi-local-auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Nix-provided `pi-local-auth` command that bootstraps repo-local Pi auth config while preserving global sessions and resources.

**Architecture:** Implement a small `pkgs.writeShellApplication` package in `modules/packages/pi-local-auth.nix`, expose it as `packages.pi-local-auth`, add it to the default dev shell, and add a Nix check that exercises the executable in temporary directories. The shell command is idempotent and only appends missing `.envrc` exports.

**Tech Stack:** Nix flakes, flake-parts modules, `pkgs.writeShellApplication`, POSIX shell, `jq` for JSON verification in checks.

---

### Task 1: Add failing Nix check for the command

**Files:**
- Create: `modules/packages/pi-local-auth.nix`

- [ ] **Step 1: Create package module with only a failing check scaffold**

Create `modules/packages/pi-local-auth.nix` containing a check that references the package before it exists:

```nix
{ ... }:
{
  perSystem =
    { pkgs, self', ... }:
    {
      checks."pi-local-auth" = pkgs.runCommand "pi-local-auth-check" { nativeBuildInputs = [ pkgs.jq ]; } ''
        workdir=$(mktemp -d)
        cd "$workdir"

        ${self'.packages."pi-local-auth"}/bin/pi-local-auth

        test -f .pi/local-agent/settings.json
        jq -e '.sessionDir == "~/.pi/agent/sessions"' .pi/local-agent/settings.json
        jq -e '.extensions == ["~/.pi/agent/extensions"]' .pi/local-agent/settings.json
        jq -e '.skills == ["~/.pi/agent/skills"]' .pi/local-agent/settings.json
        jq -e '.prompts == ["~/.pi/agent/prompts"]' .pi/local-agent/settings.json
        jq -e '.themes == ["~/.pi/agent/themes"]' .pi/local-agent/settings.json

        grep -Fx 'export PI_CODING_AGENT_DIR="$PWD/.pi/local-agent"' .envrc
        grep -Fx 'export PI_CODING_AGENT_SESSION_DIR="$HOME/.pi/agent/sessions"' .envrc

        touch "$out"
      '';
    };
}
```

- [ ] **Step 2: Run the check and verify it fails because package is missing**

Run:

```bash
nix build .#checks.x86_64-linux.pi-local-auth
```

Expected: evaluation fails because `self'.packages."pi-local-auth"` is missing.

### Task 2: Implement the executable package

**Files:**
- Modify: `modules/packages/pi-local-auth.nix`

- [ ] **Step 1: Add `packages.pi-local-auth` using `writeShellApplication`**

Update the file to include:

```nix
{ ... }:
{
  perSystem =
    { pkgs, self', ... }:
    let
      piLocalAuth = pkgs.writeShellApplication {
        name = "pi-local-auth";
        runtimeInputs = [ pkgs.coreutils pkgs.gnugrep ];
        text = ''
          set -eu

          local_agent_dir=".pi/local-agent"
          settings_file="$local_agent_dir/settings.json"
          envrc_file=".envrc"

          mkdir -p "$local_agent_dir"

          if [ ! -e "$settings_file" ]; then
            cat > "$settings_file" <<'EOF'
{
  "sessionDir": "~/.pi/agent/sessions",
  "extensions": ["~/.pi/agent/extensions"],
  "skills": ["~/.pi/agent/skills"],
  "prompts": ["~/.pi/agent/prompts"],
  "themes": ["~/.pi/agent/themes"]
}
EOF
          fi

          touch "$envrc_file"

          if ! grep -q '^[[:space:]]*\(export[[:space:]]\+\)\?PI_CODING_AGENT_DIR=' "$envrc_file"; then
            printf '%s\n' 'export PI_CODING_AGENT_DIR="$PWD/.pi/local-agent"' >> "$envrc_file"
          fi

          if ! grep -q '^[[:space:]]*\(export[[:space:]]\+\)\?PI_CODING_AGENT_SESSION_DIR=' "$envrc_file"; then
            printf '%s\n' 'export PI_CODING_AGENT_SESSION_DIR="$HOME/.pi/agent/sessions"' >> "$envrc_file"
          fi
        '';
      };
    in
    {
      packages."pi-local-auth" = piLocalAuth;

      checks."pi-local-auth" = pkgs.runCommand "pi-local-auth-check" { nativeBuildInputs = [ pkgs.jq ]; } ''
        workdir=$(mktemp -d)
        cd "$workdir"

        ${piLocalAuth}/bin/pi-local-auth

        test -f .pi/local-agent/settings.json
        jq -e '.sessionDir == "~/.pi/agent/sessions"' .pi/local-agent/settings.json
        jq -e '.extensions == ["~/.pi/agent/extensions"]' .pi/local-agent/settings.json
        jq -e '.skills == ["~/.pi/agent/skills"]' .pi/local-agent/settings.json
        jq -e '.prompts == ["~/.pi/agent/prompts"]' .pi/local-agent/settings.json
        jq -e '.themes == ["~/.pi/agent/themes"]' .pi/local-agent/settings.json

        grep -Fx 'export PI_CODING_AGENT_DIR="$PWD/.pi/local-agent"' .envrc
        grep -Fx 'export PI_CODING_AGENT_SESSION_DIR="$HOME/.pi/agent/sessions"' .envrc

        touch "$out"
      '';
    };
}
```

- [ ] **Step 2: Run the check and verify it passes**

Run:

```bash
nix build .#checks.x86_64-linux.pi-local-auth
```

Expected: build succeeds.

### Task 3: Expand tests for idempotence and existing variables

**Files:**
- Modify: `modules/packages/pi-local-auth.nix`

- [ ] **Step 1: Add check cases for existing `.envrc`, existing variable preservation, and idempotence**

Extend the check script with temporary directories that verify:

```sh
# Appends only missing session var when PI_CODING_AGENT_DIR already exists.
case_existing_dir=$(mktemp -d)
cd "$case_existing_dir"
printf '%s\n' 'export PI_CODING_AGENT_DIR="custom"' > .envrc
${piLocalAuth}/bin/pi-local-auth
grep -Fx 'export PI_CODING_AGENT_DIR="custom"' .envrc
grep -Fx 'export PI_CODING_AGENT_SESSION_DIR="$HOME/.pi/agent/sessions"' .envrc
[ "$(grep -c 'PI_CODING_AGENT_DIR=' .envrc)" -eq 1 ]

# Appends only missing dir var when PI_CODING_AGENT_SESSION_DIR already exists.
case_existing_session=$(mktemp -d)
cd "$case_existing_session"
printf '%s\n' 'PI_CODING_AGENT_SESSION_DIR=custom-session' > .envrc
${piLocalAuth}/bin/pi-local-auth
grep -Fx 'PI_CODING_AGENT_SESSION_DIR=custom-session' .envrc
grep -Fx 'export PI_CODING_AGENT_DIR="$PWD/.pi/local-agent"' .envrc
[ "$(grep -c 'PI_CODING_AGENT_SESSION_DIR=' .envrc)" -eq 1 ]

# Repeated runs do not duplicate env vars.
case_idempotent=$(mktemp -d)
cd "$case_idempotent"
${piLocalAuth}/bin/pi-local-auth
${piLocalAuth}/bin/pi-local-auth
[ "$(grep -c 'PI_CODING_AGENT_DIR=' .envrc)" -eq 1 ]
[ "$(grep -c 'PI_CODING_AGENT_SESSION_DIR=' .envrc)" -eq 1 ]
```

- [ ] **Step 2: Run the check and verify it passes**

Run:

```bash
nix build .#checks.x86_64-linux.pi-local-auth
```

Expected: build succeeds.

### Task 4: Add command to the default dev shell

**Files:**
- Modify: `modules/devshells/default.nix`

- [ ] **Step 1: Add `self'.packages.pi-local-auth` to `devShells.default.packages`**

Modify the default dev shell package list to include:

```nix
self'.packages.pi-local-auth
```

- [ ] **Step 2: Verify the dev shell exposes the command**

Run:

```bash
nix develop .#default --command bash -lc 'command -v pi-local-auth && pi-local-auth --help >/dev/null || true; command -v pi-local-auth'
```

Expected: output contains a Nix store path ending in `/bin/pi-local-auth`.

### Task 5: Final verification and commit

**Files:**
- Modify: `docs/specs/2026-05-30-pi-local-auth-design.md`
- Create: `docs/plans/2026-05-30-pi-local-auth.md`
- Create: `modules/packages/pi-local-auth.nix`
- Modify: `modules/devshells/default.nix`

- [ ] **Step 1: Format Nix files**

Run:

```bash
nix fmt
```

Expected: exits 0.

- [ ] **Step 2: Run package check**

Run:

```bash
nix build .#checks.x86_64-linux.pi-local-auth
```

Expected: build succeeds.

- [ ] **Step 3: Run repo package build smoke test**

Run:

```bash
nix build .#pi-local-auth
```

Expected: build succeeds and result links to the `pi-local-auth` package.

- [ ] **Step 4: Commit**

Run:

```bash
git add docs/specs/2026-05-30-pi-local-auth-design.md docs/plans/2026-05-30-pi-local-auth.md modules/packages/pi-local-auth.nix modules/devshells/default.nix
git commit -m "feat(pi): add local auth bootstrap command"
```
