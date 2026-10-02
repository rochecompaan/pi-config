# Roché's Pi Config

My Pi configuration packaged as a dendritic Nix flake.

Initial platform support is `x86_64-linux` only.

## Home Manager usage

```nix
{
  inputs.roche-pi.url = "github:rochecompaan/pi-config";

  imports = [ inputs.roche-pi.homeModules.default ];

  programs.roche-pi = {
    enable = true;
    stylix.enable = true;
  };
}
```

### Per-launch workflow suite

Plain `pi` uses Superpowers. Select Matt Pocock's stable engineering and productivity skills for one process with the canonical selector:

```sh
ROCHE_PI_SKILLSET=matt pi
```

For a fixed convenience command, run:

```sh
pi-matt
```

`ROCHE_PI_SKILLSET` accepts `superpowers` and `matt`; an unset value defaults to `superpowers`. For normal agent launches, `pi-matt` always selects Matt, even when `ROCHE_PI_SKILLSET=superpowers`. Both commands change the workflow skills and routing instructions only. Authentication, sessions, common extensions, local skills, models, and trust state remain under the same `~/.pi/agent` directory.

### Project credentials

The packaged Pi reads its credentials from `PI_CODING_AGENT_AUTH_FILE` when that variable is set. `/login`, `/logout` and `pi auth` then use that file instead of `~/.pi/agent/auth.json`. Settings, extensions, skills, sessions and MCP credentials (`mcp-auth.json`) stay in `~/.pi/agent`. A patch in this flake adds the variable; upstream Pi does not support it.

To give a direnv project its own credentials, run `pi-local-auth` (the `pi-local-auth` package) once in the project root, then `direnv allow`. It creates `.pi/local-agent/auth.json` with mode 0600 and adds this line to `.envrc`:

```sh
export PI_CODING_AGENT_AUTH_FILE="$PWD/.pi/local-agent/auth.json"
```

It also removes the `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` lines that earlier versions added. Keep `.pi/local-agent/` out of version control. `pi-local-auth` refuses a symlinked `auth.json`, because Pi reads and writes through it; to share credentials between projects, set `PI_CODING_AGENT_AUTH_FILE` to the same file in each `.envrc`. The status line shows `auth: LOCAL` when Pi uses a credentials file other than `~/.pi/agent/auth.json`.

## Context paging

The packaged configuration enables context paging with a default rolling budget of 128,000 estimated tokens:

```json
{
  "contextPaging": {
    "enabled": true,
    "tokenBudget": 128000
  }
}
```

`tokenBudget` is optional. It must be a positive safe integer. A trusted project's `.pi/settings.json` can override the global value. An untrusted project is ignored, and an invalid value falls through to the next valid source or the 128,000-token default.

When the active model declares a smaller context window, the extension uses that smaller value. Paging notices show the effective rolling budget. The setting does not change output-page sizes or history recovery limits.

After a successful provider response, paging uses its measured context total as an anchor for the exact context it sent. It estimates only later additions, removals, resident-input changes, and generated notices. Outgoing-only extension instructions remain in the measured request, but their later removal does not invalidate a matching persistent session. Until a tracked response provides that anchor, it uses Pi's normal message estimate. The budget stays unchanged at 128,000 tokens (or the smaller model window). A changed request is still an estimate before its next provider response reports usage.

## Per-project usage

A project can provide Pi without installing the Home Manager module. For a devenv project, add the flake input to `devenv.yaml`:

```yaml
inputs:
  nixpkgs:
    url: github:cachix/devenv-nixpkgs/rolling
  roche-pi:
    url: github:rochecompaan/pi-config
```

Then install Pi and bootstrap its project resources from `devenv.nix`:

```nix
{ inputs, pkgs, ... }:

let
  system = pkgs.stdenv.hostPlatform.system;
  rochePi = inputs.roche-pi;
  piConfig = rochePi.packages.${system}.pi-config;
in
{
  packages = [ rochePi.packages.${system}.pi ];

  enterShell = ''
    export PI_CODING_AGENT_DIR="$DEVENV_ROOT/.pi/agent"
    mkdir -p "$PI_CODING_AGENT_DIR"

    for resource in \
      AGENTS.md \
      settings.json \
      mcp.json \
      agents \
      extensions \
      multi-model-planning-teams \
      node_modules \
      skills \
      themes
    do
      ln -sfnT "${piConfig}/$resource" "$PI_CODING_AGENT_DIR/$resource"
    done
  '';
}
```

Add `.pi/` to the project `.gitignore`, then run `devenv shell` and launch `pi`. This uses the Pi executable. `PI_CODING_AGENT_DIR` points to the repository-local `.pi/agent`, which receives the packaged configuration while keeping project credentials and sessions out of the global agent directory.

For another Nix project shell, use the same bootstrap script in its `shellHook` and replace `$DEVENV_ROOT` with the project root variable available there.
