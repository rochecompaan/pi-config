{ lib }:
{
  mkAuthSetup =
    {
      authMode,
      globalAuthPathExpr ? ''"$HOME/.pi/agent/auth.json"'',
    }:
    assert lib.assertMsg (builtins.elem authMode [
      "global"
      "local"
    ]) "jailed Pi authMode must be either \"global\" or \"local\"";
    ''
      global_auth=${globalAuthPathExpr}
      auth_path="$agent_dir/auth.json"

      jailed_pi_auth_conflict() {
        echo "jailed Pi global auth mode will not replace $auth_path; move or remove it before enabling global auth" >&2
        exit 1
      }

      case ${lib.escapeShellArg authMode} in
        global)
          if [ -L "$auth_path" ]; then
            if [ "$(readlink "$auth_path")" != "$global_auth" ]; then
              jailed_pi_auth_conflict
            fi
          elif [ -e "$auth_path" ]; then
            jailed_pi_auth_conflict
          fi

          mkdir -p "$(dirname "$global_auth")"
          touch "$global_auth"
          if [ ! -L "$auth_path" ]; then
            ln -s "$global_auth" "$auth_path"
          fi
          ;;
        local)
          if [ -L "$auth_path" ] && [ "$(readlink "$auth_path")" = "$global_auth" ]; then
            rm "$auth_path"
          fi
          ;;
      esac
    '';
}
