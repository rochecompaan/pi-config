{ inputs, ... }:
{
  perSystem =
    {
      pkgs,
      self',
      system,
      ...
    }:
    {
      lib.mkJailedPi =
        (import ../../nix/lib/mk-jailed-pi.nix {
          inherit
            inputs
            pkgs
            self'
            system
            ;
          githubBrokerServerPackage = self'.packages."jailed-github-broker";
        }).mkJailedPi;
    };
}
