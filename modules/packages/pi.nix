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
      upstreamPi = inputs.llm-agents.packages.${system}.pi.overrideAttrs (old: {
        patches = (old.patches or [ ]) ++ [ ../../nix/packages/pi-new-session-model-retention.patch ];
        preInstall = ''
          PI_DIST_DIR="$PWD/dist" ${pkgs.nodejs}/bin/node --test \
            ${../../nix/packages/pi-new-session-model-retention-rpc.test.mjs} \
            ${../../nix/packages/pi-new-session-model-retention.test.mjs}
        ''
        + (old.preInstall or "");
      });
      piDeps = import ../../nix/packages/pi-deps.nix {
        inherit pkgs;
        piRemote = self'.packages.pi-remote;
      };
      mkPiSkillsetWrapper = import ../../nix/packages/pi-skillset-wrapper.nix;

      skillsets = {
        superpowers = {
          package = piDeps.superpowersSrc;
          instructions = builtins.readFile ../../profiles/superpowers/APPEND_SYSTEM.md;
        };
        matt = {
          package = piDeps.mattPocockSkills;
          instructions = builtins.readFile ../../profiles/matt/APPEND_SYSTEM.md;
        };
      };
    in
    {
      packages = {
        pi = mkPiSkillsetWrapper {
          inherit pkgs skillsets;
          piPackage = upstreamPi;
        };
        pi-matt = mkPiSkillsetWrapper {
          inherit pkgs skillsets;
          piPackage = upstreamPi;
          programName = "pi-matt";
          defaultSkillset = "matt";
          allowSelection = false;
        };
        pi-superpowers = mkPiSkillsetWrapper {
          inherit pkgs skillsets;
          piPackage = upstreamPi;
          allowSelection = false;
        };
        mattpocock-skills = piDeps.mattPocockSkills;
      };
    };
}
