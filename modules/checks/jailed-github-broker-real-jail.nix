{ inputs, ... }:
{
  perSystem =
    { pkgs, self', ... }:
    let
      realJail = import ../../nix/check-support/jailed-github-broker-real-jail.nix {
        inherit inputs pkgs self';
      };
    in
    {
      checks."jailed-github-broker-real-jail" = realJail.check;
    };
}
