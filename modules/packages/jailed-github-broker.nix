{ ... }:
{
  perSystem =
    { pkgs, ... }:
    {
      packages."jailed-github-broker" = import ../../nix/packages/jailed-github-broker.nix {
        inherit pkgs;
      };
    };
}
