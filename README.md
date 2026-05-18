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

### Jailed Pi

```nix
{
  imports = [
    inputs.roche-pi.homeModules.default
    inputs.roche-pi.homeModules."jailed-pi"
  ];

  programs.roche-pi = {
    enable = true;
    stylix.enable = true;

    jailed = {
      enable = true;
      apiKeys = {
        OPENROUTER_API_KEY.file = config.sops.secrets."openrouter-api-key".path;
        ANTHROPIC_API_KEY.fromEnv = true;
      };
      # docker.enable = true; # optional; grants access to the host Docker socket
      # podman.enable = true; # optional; uses a rootless host Podman socket when available
      extraPkgs = [ pkgs.neovim ];
    };
  };
}
```

`docker.enable` binds the host Docker socket into the jail and should be enabled only for trusted project or host profiles. It includes `docker` and `docker-compose`. `podman.enable` adds Podman client tooling (`podman` and `podman-compose`) and binds the rootless host Podman socket path when available; it expects a host Podman service rather than launching nested local containers inside the jail.

## Project shell usage

```nix
shellHook = ''
  ${inputs.roche-pi.lib.${system}.projectPiShellHook {
    agentTeam = "openai-only";
    # includePackage = true; # opt-in for self-contained project-local package loading
  }}
''';
```

`projectPiShellHook` defaults to `includePackage = false`, so it will not include the project Pi package by default and avoids duplicate global extension loading. Set `includePackage = true` when you need project-local package-based extensions to be loaded explicitly.

### Project jailed Pi shell

`projectPiShellHook` can create a project-local jailed agent directory when paired with `lib.${system}.mkJailedPi`:

```nix
pkgs.mkShell {
  packages = [
    (inputs.roche-pi.lib.${system}.mkJailedPi {
      agentConfigPackage = inputs.roche-pi.packages.${system}.pi-config;
      defaultAgentDir = "$PWD/.pi/agent-jailed";
      apiKeys = {
        OPENROUTER_API_KEY.fromEnv = true;
        ANTHROPIC_API_KEY.fromEnv = true;
      };
      # docker.enable = true; # optional; grants access to the host Docker socket
      # podman.enable = true; # optional; uses a rootless host Podman socket when available
      extraPkgs = [ pkgs.kubectl pkgs.gh ];
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
