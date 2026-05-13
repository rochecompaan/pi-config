{ lib, ... }:
let
  inherit (lib) mkEnableOption mkIf;

  jailedPiModule =
    { config, ... }:
    {
      options.programs."roche-pi".jailed.enable =
        mkEnableOption "the reserved jailed Roche Pi Home Manager migration";

      config = mkIf config.programs."roche-pi".jailed.enable {
        assertions = [
          {
            assertion = false;
            message = "programs.roche-pi.jailed.enable is reserved for the follow-up jailed Pi migration.";
          }
        ];
      };
    };
in
{
  flake.homeModules."jailed-pi" = jailedPiModule;
}
