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
    baseSettings
    // {
      inherit theme;
      packages =
        packagePaths ++ lib.optional (intervalsPackagePath != null) intervalsPackagePath ++ extraPackages;
    }
    // settingsOverrides;
}
