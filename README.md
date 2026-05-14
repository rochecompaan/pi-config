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
