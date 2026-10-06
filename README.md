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

## Den sandbox usage

`pi-den` runs this configuration inside a [Den](https://github.com/rochecompaan/den) sandbox. It uses Den's packaged Pi and adds the CodeGraph, CodeGraph Viz and Notion command-line tools:

```bash
nix run github:rochecompaan/pi-config#pi-den
```

Den requires `REPOWOLF_ENDPOINT`, `REPOWOLF_TOKEN` and `REPOWOLF_CA_FILE` at launch; see Den's README. Set them in your environment. They are secrets, so never write them into Nix files. The sandbox can read the whole Nix store, so keep all secrets out of it.

`pi-den` keeps Pi's state in Den's agent directory: `~/.local/state/den/pi/agent` by default, or the directory in `PI_CODING_AGENT_DIR`. It does not read `~/.pi/agent` unless you select that directory. Before every launch, Den restores these packaged paths as links into the Nix store:

- `settings.json`, `AGENTS.md`, `mcp.json` and `claude-bridge.json`
- `loadout.json` and `loadout-profiles.json`
- `agents`
- `profiles/pi-subagents/openai.json` and `profiles/pi-subagents/kimi.json`

Changes to these paths last only until the next launch. Den leaves everything else as you left it: `auth.json`, sessions, caches, trust decisions, Context Mode data, extra subagent profiles and any other file. Each agent directory has its own `auth.json`; `pi-den` does not support `PI_CODING_AGENT_AUTH_FILE`.

Pi cannot write to `HOME` inside Den, so extensions such as Context Mode and remote-pi also keep their data in the agent directory. As a result, Pi in Den has its own private remote-pi mesh. It cannot see or message agents that run on the host.

To reuse the resources in your own Den configuration, add the bundle to either agent:

```nix
programs.den.pi.bundles = [
  inputs.roche-pi.packages.${pkgs.system}.den-bundle
];

programs.den.claude.bundles = [
  inputs.roche-pi.packages.${pkgs.system}.den-bundle
];
```

For Pi, the bundle adds this configuration's Pi packages. For Claude Code, it adds the Context Mode MCP server and the skills that work without Pi tools or extra credentials. The bundle does not manage Pi's settings files or add command-line tools. Choose those with Den's `stateFiles` and `extraPkgs` options.

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
      loadout.json \
      loadout-profiles.json \
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
