{ lib, pkgs }:
let
  envNames = [
    "GIT_CONFIG_COUNT"
    "GIT_CONFIG_KEY_0"
    "GIT_CONFIG_VALUE_0"
    "GIT_CONFIG_KEY_1"
    "GIT_CONFIG_VALUE_1"
  ];

  unsetTransport = ''
    unset ${lib.concatStringsSep " " envNames}
  '';
in
{
  inherit envNames;

  mkSetupScript =
    {
      inheritGitIdentity ? true,
      gitUserName ? null,
      gitUserEmail ? null,
    }:
    assert lib.assertMsg (
      (gitUserName == null) == (gitUserEmail == null)
    ) "jailed Pi Git identity requires both gitUserName and gitUserEmail";
    if gitUserName != null then
      ''
        ${unsetTransport}
        export GIT_CONFIG_COUNT=2
        export GIT_CONFIG_KEY_0=user.name
        export GIT_CONFIG_VALUE_0=${lib.escapeShellArg gitUserName}
        export GIT_CONFIG_KEY_1=user.email
        export GIT_CONFIG_VALUE_1=${lib.escapeShellArg gitUserEmail}
      ''
    else if inheritGitIdentity then
      ''
        jailed_pi_git_user_name="$(${lib.getExe pkgs.git} config --includes --get user.name 2>/dev/null || true)"
        jailed_pi_git_user_email="$(${lib.getExe pkgs.git} config --includes --get user.email 2>/dev/null || true)"

        ${unsetTransport}

        if [ -n "$jailed_pi_git_user_name" ] && [ -n "$jailed_pi_git_user_email" ]; then
          export GIT_CONFIG_COUNT=2
          export GIT_CONFIG_KEY_0=user.name
          export GIT_CONFIG_VALUE_0="$jailed_pi_git_user_name"
          export GIT_CONFIG_KEY_1=user.email
          export GIT_CONFIG_VALUE_1="$jailed_pi_git_user_email"
        fi

        unset jailed_pi_git_user_name jailed_pi_git_user_email
      ''
    else
      unsetTransport;
}
