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
        "pi-auto-reload" = piDeps.piAutoReload;
        "pi-codegraph" = piDeps.piCodegraph;
        "pi-claude-bridge" = piDeps.piClaudeBridge;
        "pi-context-paging" = piDeps.piContextPaging;
        "remote-pi-extension" = piDeps.remotePiExtension;
        "superpowers-source" = piDeps.superpowersSrc;
        "simple-english-source" = piDeps.simpleEnglishSrc;
        "pi-voice" = piDeps.piVoice;
        "pi-loadout" = piDeps.piLoadout;
        "pi-subagents" = piDeps.piSubagents;
        "pi-vim" = piDeps.piVim;
      };
    };
}
