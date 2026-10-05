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

### Workflow skills

The standard `pi` package includes our Pi patches, without a workflow-suite wrapper. Both Superpowers and Matt Pocock's engineering and productivity skills are available through the managed configuration.

Use `/loadout` to choose active skills and save profiles. The old `pi-matt`, `pi-superpowers`, and `ROCHE_PI_SKILLSET` selector are removed. Pi does not append suite instructions at launch. Shared `AGENTS.md` instructions contain conditional Pi workflow mappings.

Enable `using-superpowers` to receive the Superpowers reminder at session start, after compaction, and after an inactive run. Other Superpowers skills can remain active without this reminder. Disabling `using-superpowers` prevents new reminders but does not erase instructions already read in the conversation.

Authentication, sessions, extensions, models, and trust state stay in the same `~/.pi/agent` directory.

### Project credentials

The packaged Pi reads its credentials from `PI_CODING_AGENT_AUTH_FILE` when that variable is set. `/login`, `/logout` and `pi auth` then use that file instead of `~/.pi/agent/auth.json`. Settings, extensions, skills, sessions and MCP credentials (`mcp-auth.json`) stay in `~/.pi/agent`. A patch in this flake adds the variable; upstream Pi does not support it.

To give a direnv project its own credentials, run `pi-local-auth` (the `pi-local-auth` package) once in the project root, then `direnv allow`. It creates `.pi/local-agent/auth.json` with mode 0600 and adds this line to `.envrc`:

```sh
export PI_CODING_AGENT_AUTH_FILE="$PWD/.pi/local-agent/auth.json"
```

It also removes the `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` lines that earlier versions added. Keep `.pi/local-agent/` out of version control. `pi-local-auth` refuses a symlinked `auth.json`, because Pi reads and writes through it; to share credentials between projects, set `PI_CODING_AGENT_AUTH_FILE` to the same file in each `.envrc`. The status line shows `auth: LOCAL` when Pi uses a credentials file other than `~/.pi/agent/auth.json`.

## Context paging

Context paging comes from the published [`@rochecompaan/pi-context-paging`](https://github.com/rochecompaan/pi-context-paging) package. `nix/dependency-pins.json` pins its npm release, and the dependency updates keep it current like the other packages.

The packaged settings turn paging off:

```json
{
  "contextPaging": {
    "enabled": false,
    "tokenBudget": 128000
  }
}
```

To turn it on with Home Manager:

```nix
programs.roche-pi.settings.contextPaging.enabled = true;
```

A trusted project's `.pi/settings.json` can also set `contextPaging`. While paging is off, the recovery tools stay registered but refuse to run. The package README describes `tokenBudget`, `trimToTokens`, and how paging works.

To change paging for the current session only, run `/context-paging on` or `/context-paging off`. `/context-paging` shows the current state. The command does not change saved settings. A new session, a resume, a fork, or a reload restores them.

The status footer shows the current state next to relay and voice. A green `● paging` means paging is on. A red `○ paging` means it is off.

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
