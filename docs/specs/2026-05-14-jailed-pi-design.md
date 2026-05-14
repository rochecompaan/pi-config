# Jailed Pi Design

## Goal

Move the jailed Pi configuration out of `nixdots` and into this `roche-pi` flake, while keeping the normal Pi and jailed Pi configurations in sync and allowing project development shells to opt into a jailed Pi with project-specific Nix packages.

## Background

The current jailed Pi implementation lives in `/home/roche/nixdots/modules/home/desktop/utils/jailed-agents/default.nix`. It directly wraps `inputs.llm-agents.packages.${system}.pi` with `jail-nix`, creates `~/.pi/agent-jailed` during Home Manager activation, reads an OpenRouter key from a sops secret path, and duplicates the Pi resource wiring from the normal Pi configuration.

This repository already owns the Pi config package and Home Manager module:

- `modules/packages/pi-config.nix` builds the base Pi configuration package.
- `modules/home/pi.nix` generates the effective Home Manager Pi configuration, including settings overrides, Stylix themes, and optional Intervals resources.
- `modules/home/jailed-pi.nix` is currently a reserved stub for the migration.
- `modules/lib/project-pi.nix` provides `projectPiShellHook` for project-local Pi config in development shells.

## Decisions

- Add `jail-nix` as a flake input in this repository.
- Keep `roche-pi` independent of `sops-nix`; callers pass secret file paths explicitly.
- Make jailed Pi use the same effective Pi config as normal `programs.roche-pi`.
- Provide a low-level `mkJailedPi` builder so Home Manager and development shells share the same jail logic.
- Keep development shell jailed Pi opt-in.
- Allow development shells to add extra Nix packages inside the jailed runtime.
- Support arbitrary AI provider API keys from either key files or forwarded environment variables.

## Architecture

### Shared effective Pi config

Extract the effective Pi resource generation from `modules/home/pi.nix` into `nix/lib/pi-resources.nix`.

The helper should accept the same inputs currently used by the Home Manager module to produce the effective runtime resources:

- base Pi config package
- settings overrides
- Stylix enablement and palette
- Intervals enablement and package/path selection
- `pkgs`

It should return a resource package or attrset whose paths are consumed by both normal and jailed Pi setup:

- `AGENTS.md`
- `settings.json`
- `extensions`
- `agent-teams`
- `agents`
- `skills`
- `themes`
- `node_modules`
- dashboard config JSON/text

`modules/home/pi.nix` should use this helper instead of constructing these resources inline. `modules/home/jailed-pi.nix` should use the same helper so jailed Pi inherits settings overrides, Stylix, and Intervals behavior without duplicating logic.

### Reusable jailed Pi builder

Add a per-system library function exposed as `lib.${system}.mkJailedPi`. The builder is responsible only for creating the jailed executable package; it should not create user directories or Home Manager files.

The intended interface is:

```nix
mkJailedPi {
  name ? "jailed-pi";
  piPackage ? inputs.llm-agents.packages.${system}.pi;
  agentConfigPackage;
  defaultAgentDir ? "$HOME/.pi/agent-jailed";
  apiKeys ? { };
  editor ? "vi";
  gitUserName ? null;
  gitUserEmail ? null;
  extraPkgs ? [ ];
  runtimeClosurePkgs ? [ agentConfigPackage ];
  extraPermissions ? [ ];
}
```

`apiKeys` is an attribute set keyed by the environment variable that Pi/provider SDKs expect. Each entry has this shape:

```nix
{
  OPENROUTER_API_KEY = {
    file = config.sops.secrets."openrouter-api-key".path;
    fromEnv = false;
  };
  ANTHROPIC_API_KEY = {
    file = null;
    fromEnv = true;
  };
}
```

`file` defaults to `null`. `fromEnv` defaults to `true` when `file = null`, and `false` when `file` is set, so common cases stay concise. If both are enabled for the same variable, the file value takes precedence over the forwarded environment value.

The builder should:

- wrap the Pi executable so `EDITOR`, `GIT_EDITOR`, `VISUAL`, and `PI_CODING_AGENT_DIR` are set before Pi starts;
- support arbitrary provider API key environment variables through `apiKeys`;
- for each `apiKeys.<ENV_NAME>.file`, read the file before entering Pi and export its content as `<ENV_NAME>`;
- for each `apiKeys.<ENV_NAME>.fromEnv = true`, preserve a caller-provided `<ENV_NAME>` by forwarding it into the jail;
- use `jail-nix` with the common permissions from the current nixdots implementation: network, time zone, no new session, and mounted current working directory;
- allow read-write access to the configured agent directory, auth file, and sessions directory;
- allow read-only access to the effective Pi config package and configured key files;
- include common command-line dependencies such as `bashInteractive`, `coreutils`, `curl`, `diffutils`, `findutils`, `gawkInteractive`, `gnugrep`, `gnused`, `gnutar`, `gzip`, `jq`, `pre-commit`, `procps`, `ripgrep`, `unzip`, `wget`, `which`, and `git`;
- include caller-provided `extraPkgs` inside the jail;
- add runtime closure bindings for `runtimeClosurePkgs` so store-backed Pi resources remain accessible inside the jail;
- optionally inject git identity environment variables when both `gitUserName` and `gitUserEmail` are provided.

### Home Manager module

Replace the assertion-only `modules/home/jailed-pi.nix` stub with real options under `programs.roche-pi.jailed`:

```nix
programs.roche-pi.jailed = {
  enable = true;
  packageName = "jailed-pi";
  agentDir = "${config.home.homeDirectory}/.pi/agent-jailed";
  apiKeys = { };
  editor = config.home.sessionVariables.EDITOR or "vi";
  extraPkgs = [ ];
  extraPermissions = [ ];
};
```

When enabled, the module should:

1. Require `programs.roche-pi.enable = true`, so the jailed module always derives resources from the enabled normal Roche Pi configuration.
2. Generate the same effective Pi config resources used by `programs.roche-pi`.
3. Create `~/.pi/agent-jailed` during activation.
4. Link immutable resources from the effective config package into `~/.pi/agent-jailed`.
5. Link mutable state from the normal user Pi state into the jailed directory:
   - `~/.pi/agent/auth.json`
   - `~/.pi/agent/sessions`
6. Add the `mkJailedPi` result to `home.packages`.

The module should not declare sops secrets. A nixdots consumer will continue to own secret declaration and pass resulting paths through `programs.roche-pi.jailed.apiKeys`.

### Project development shell integration

Keep existing `devShells.default` behavior unchanged: it should include normal `pi` and call `projectPiShellHook` as it does today.

Add opt-in development shell support for jailed Pi through the reusable builder and project hook. The low-level pattern should be:

```nix
pkgs.mkShell {
  packages = [
    (inputs.roche-pi.lib.${system}.mkJailedPi {
      agentConfigPackage = inputs.roche-pi.packages.${system}.pi-config;
      defaultAgentDir = "$PWD/.pi/agent-jailed";
      extraPkgs = [ pkgs.kubectl pkgs.gh ];
      apiKeys = {
        OPENROUTER_API_KEY.fromEnv = true;
        ANTHROPIC_API_KEY.fromEnv = true;
      };
    })
  ];

  shellHook = ''
    ${inputs.roche-pi.lib.${system}.projectPiShellHook {
      agentTeam = "openai-only";
      jailedPi.enable = true;
    }}
  '';
}
```

Extend `projectPiShellHook` with an optional `jailedPi` argument. When enabled, the hook should create project-local jailed resources under `.pi/agent-jailed`, link them to the flake-provided config package, and export `PI_CODING_AGENT_DIR="$PWD/.pi/agent-jailed"` for the shell session. The hook should not force `includePackage = true`; package loading remains an explicit existing option.

Development shells can provide AI provider credentials either by exporting configured environment variables before entering the shell or by constructing `mkJailedPi` with `apiKeys.<ENV_NAME>.file`.

## Error handling and validation

The Home Manager module should assert that:

- each `programs.roche-pi.jailed.apiKeys.<ENV_NAME>.file`, when non-null, is an absolute path;
- each `programs.roche-pi.jailed.apiKeys` attribute name is a valid POSIX environment variable name;
- `programs.roche-pi.jailed.agentDir` is an absolute path;
- git identity injection only occurs when both git name and email are available;
- jailed Pi is not enabled without an effective config package.

The builder should avoid requiring provider API keys at Nix evaluation time. Missing credentials should fail at Pi runtime in the same way normal Pi authentication failures do.

## Testing

Implementation should verify:

- `nix flake check`
- `nix build .#packages.x86_64-linux.pi-config`
- `nix eval .#lib.x86_64-linux.mkJailedPi --apply builtins.isFunction` returning `true`
- `nix build` of a small generated jailed Pi package
- evaluation of the Home Manager module with `programs.roche-pi.jailed.enable = true`
- project shell hook output when `jailedPi.enable = true`

Manual smoke testing should confirm:

- `jailed-pi --help` starts through the jail wrapper;
- `PI_CODING_AGENT_DIR` points at the jailed agent directory;
- extra packages passed to `mkJailedPi.extraPkgs` are available inside commands spawned by jailed Pi;
- normal `pi` devshell behavior remains unchanged when jailed support is not enabled.

## Migration path

After this repository exposes the jailed module and builder, nixdots should remove the old `/home/roche/nixdots/modules/home/desktop/utils/jailed-agents/default.nix` implementation and replace it with configuration similar to:

```nix
{ inputs, config, pkgs, ... }:
{
  imports = [
    inputs.roche-pi.homeModules.default
    inputs.roche-pi.homeModules."jailed-pi"
  ];

  programs.roche-pi = {
    enable = true;
    jailed = {
      enable = true;
      apiKeys = {
        OPENROUTER_API_KEY.file = config.sops.secrets."openrouter-api-key".path;
        ANTHROPIC_API_KEY.fromEnv = true;
      };
      extraPkgs = [ pkgs.neovim ];
    };
  };
}
```

This keeps secrets and host-specific package choices in nixdots while the reusable jailed Pi implementation lives in this repository.
