{
  pkgs,
  piPackage,
  skillsets,
  programName ? "pi",
  defaultSkillset ? "superpowers",
  allowSelection ? true,
}:
let
  inherit (pkgs) lib;

  wrapperSkillsets =
    if allowSelection then
      skillsets
    else
      lib.filterAttrs (skillsetName: _: skillsetName == defaultSkillset) skillsets;

  acceptedSkillsets = builtins.attrNames wrapperSkillsets;
  acceptedSkillsetsText = lib.concatStringsSep ", " acceptedSkillsets;

  skillsetCases = lib.concatStringsSep "\n" (
    lib.mapAttrsToList (skillsetName: profile: ''
      ${skillsetName})
        suite_package=${lib.escapeShellArg (toString profile.package)}
        suite_instructions=${lib.escapeShellArg profile.instructions}
        ;;
    '') wrapperSkillsets
  );
in
assert lib.assertMsg (builtins.hasAttr defaultSkillset skillsets)
  "default Pi skill set '${defaultSkillset}' is not defined";
pkgs.writeShellApplication {
  name = programName;
  # Suite prompts are literal data even when their Markdown resembles shell syntax.
  excludeShellChecks = [ "SC2016" ];
  text = ''
    set -euo pipefail

    ${
      if allowSelection then
        ''selected_skillset="''${ROCHE_PI_SKILLSET:-${defaultSkillset}}"''
      else
        "selected_skillset=${lib.escapeShellArg defaultSkillset}"
    }

    case "$selected_skillset" in
      ${skillsetCases}
      *)
        printf 'pi: unsupported ROCHE_PI_SKILLSET=%s; expected one of: ${acceptedSkillsetsText}\n' \
          "$selected_skillset" >&2
        exit 2
        ;;
    esac

    case "''${1:-}" in
      install|remove|uninstall|update|list|config|auth)
        exec ${lib.getExe piPackage} "$@"
        ;;
    esac

    for arg in "$@"; do
      case "$arg" in
        --)
          break
          ;;
        --help|-h|--version|-v|--list-models)
          exec ${lib.getExe piPackage} "$@"
          ;;
      esac
    done

    exec ${lib.getExe piPackage} \
      --extension "$suite_package" \
      --append-system-prompt "$suite_instructions" \
      "$@"
  '';
  meta.mainProgram = programName;
}
