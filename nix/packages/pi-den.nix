{
  pkgs,
  mkPi,
  piConfig,
  denBundle,
  extraPkgs,
  piVersion,
}:
let
  piSettings = import ../lib/pi-settings.nix { inherit (pkgs) lib; };
  # Den passes the bundle packages as immutable arguments, so a packages key
  # would load each package twice.
  denSettingsValue = builtins.removeAttrs (piSettings {
    inherit piVersion;
    packagePaths = [ ];
  }) [ "packages" ];
  denSettings = pkgs.writeText "roche-pi-den-settings.json" (builtins.toJSON denSettingsValue);

  # Den passes this environment through to Pi. Pi cannot write to HOME inside
  # Den, so remote-pi keeps a private mesh in Den's agent directory.
  environment = {
    REMOTE_PI_HOME_FROM_AGENT_DIR = "1";
  };

  denPackage = mkPi {
    bundles = [ denBundle ];
    inherit extraPkgs;
    stateFiles.agent = {
      "settings.json" = denSettings;
      "AGENTS.md" = "${piConfig}/AGENTS.md";
      "mcp.json" = "${piConfig}/mcp.json";
      "claude-bridge.json" = "${piConfig}/claude-bridge.json";
      "loadout.json" = "${piConfig}/loadout.json";
      "loadout-profiles.json" = "${piConfig}/loadout-profiles.json";
      "agents" = "${piConfig}/agents";
      "profiles/pi-subagents/openai.json" = "${piConfig}/profiles/pi-subagents/openai.json";
      "profiles/pi-subagents/kimi.json" = "${piConfig}/profiles/pi-subagents/kimi.json";
    };
  };
in
pkgs.runCommand "pi-den"
  {
    nativeBuildInputs = [ pkgs.makeWrapper ];
    meta.mainProgram = "pi-den";
    passthru = { inherit denPackage denSettings environment; };
  }
  ''
    mkdir -p "$out/bin"
    makeWrapper ${denPackage}/bin/pi "$out/bin/pi-den" \
      ${pkgs.lib.concatStringsSep " " (pkgs.lib.mapAttrsToList (name: value: "--set ${name} ${pkgs.lib.escapeShellArg value}") environment)}
  ''
