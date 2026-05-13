{ lib }:
{
  mkSettings =
    {
      baseSettings,
      packagePaths ? [ ],
      extraPackages ? [ ],
      theme ? "stylix",
      settingsOverrides ? { },
      intervalsPackagePath ? null,
    }:
    let
      generatedSettings = baseSettings // {
        inherit theme;
        packages =
          packagePaths ++ lib.optional (intervalsPackagePath != null) intervalsPackagePath ++ extraPackages;
      };
    in
    lib.recursiveUpdate generatedSettings settingsOverrides;
}
