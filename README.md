# roche-pi

Personal-first Pi configuration packaged as a dendritic Nix flake.

Initial platform support is `x86_64-linux` only.

These usage examples are valid after the Home Manager module and project helper modules are implemented in later tasks.

## Home Manager usage

```nix
{
  inputs.roche-pi.url = "github:rochecompaan/roche-pi";

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
  }}
'';
```
