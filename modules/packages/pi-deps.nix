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
        "diff-package" = piDeps.diffPackage;
        "pi-listen" = piDeps.piListen;
        "pi-messenger-bridge" = piDeps.piMessengerBridge;
        "pi-subagents" = piDeps.piSubagents;
      };
    };
}
