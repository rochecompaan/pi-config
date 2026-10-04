{ ... }:
{
  perSystem =
    { config, pkgs, ... }:
    let
      piDeps = import ../../nix/packages/pi-deps.nix {
        inherit pkgs;
        piRemote = config.packages."pi-remote";
      };
    in
    {
      packages = {
        "codegraph" = piDeps.codegraphCli;
        "context-mode" = piDeps.contextMode;
        "diff-package" = piDeps.diffPackage;
        "pi-codegraph" = piDeps.piCodegraph;
        "pi-claude-bridge" = piDeps.piClaudeBridge;
        "remote-pi-extension" = piDeps.remotePiExtension;
        "superpowers-source" = piDeps.superpowersSrc;
        "simple-english-source" = piDeps.simpleEnglishSrc;
        "pi-listen" = piDeps.piListen;
        "pi-loadout" = piDeps.piLoadout;
        "pi-subagents" = piDeps.piSubagents;
        "pi-vim" = piDeps.piVim;
      };
    };
}
