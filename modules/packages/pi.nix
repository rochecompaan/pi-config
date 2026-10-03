{ inputs, ... }:
{
  perSystem =
    {
      pkgs,
      self',
      system,
      ...
    }:
    let
      upstreamPi = inputs.llm-agents.packages.${system}.pi;
      piPackage = import ../../nix/packages/pi-patched.nix {
        inherit pkgs upstreamPi;
      };
      piDeps = import ../../nix/packages/pi-deps.nix {
        inherit pkgs;
        piRemote = self'.packages.pi-remote;
      };
    in
    {
      packages = {
        pi = piPackage;
        mattpocock-skills = piDeps.mattPocockSkills;
        superpowers = piDeps.superpowers;
      };

      checks.superpowers-loadout-bootstrap =
        pkgs.runCommand "superpowers-loadout-bootstrap"
          {
            nativeBuildInputs = [ pkgs.nodejs_24 ];
            SUPERPOWERS_PACKAGE = piDeps.superpowers;
          }
          ''
            node --test ${../../nix/check-support/superpowers-loadout.test.mjs}
            touch "$out"
          '';
    };
}
