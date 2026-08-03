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
        "pi-listen" = piDeps.piListen;
        "pi-messenger-bridge" = piDeps.piMessengerBridge;
        "pi-subagents" = piDeps.piSubagents;
        "pi-vim" = piDeps.piVim;
      };
    };
}
