{ ... }:
{
  perSystem =
    { pkgs, ... }:
    {
      packages."pi-intervals" = import ../../nix/packages/pi-intervals.nix { inherit pkgs; };
    };
}
