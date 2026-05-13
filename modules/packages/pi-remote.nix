{ ... }:
{
  perSystem =
    { pkgs, ... }:
    {
      packages."pi-remote" = import ../../nix/packages/pi-remote.nix { inherit pkgs; };
    };
}
