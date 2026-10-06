{ lib }:
{
  piVersion,
  packagePaths ? [ ],
  theme ? "stylix",
  settingsOverrides ? { },
}:
let
  settingsLib = import ./settings.nix { inherit lib; };
  baseSettings = builtins.fromJSON (builtins.readFile ../../settings.json);
in
settingsLib.mkSettings {
  inherit baseSettings packagePaths theme;
  settingsOverrides = lib.recursiveUpdate {
    lastChangelogVersion = piVersion;
  } settingsOverrides;
}
