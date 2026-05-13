{ ... }:
{
  perSystem =
    { pkgs, ... }:
    {
      packages."notion-cli" = import ../../nix/packages/notion-cli.nix { inherit pkgs; };
    };
}
