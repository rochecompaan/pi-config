{ ... }:
{
  perSystem =
    { pkgs, ... }:
    let
      piLocalAuth = pkgs.writeShellApplication {
        name = "pi-local-auth";
        runtimeInputs = [
          pkgs.coreutils
          pkgs.gnugrep
        ];
        text = ''
                    set -eu

                    local_agent_dir=".pi/local-agent"
                    settings_file="$local_agent_dir/settings.json"
                    envrc_file=".envrc"

                    mkdir -p "$local_agent_dir"

                    if [ ! -e "$settings_file" ]; then
                      cat > "$settings_file" <<'EOF'
          {
            "sessionDir": "~/.pi/agent/sessions",
            "extensions": ["~/.pi/agent/extensions"],
            "skills": ["~/.pi/agent/skills"],
            "prompts": ["~/.pi/agent/prompts"],
            "themes": ["~/.pi/agent/themes"]
          }
          EOF
                    fi

                    touch "$envrc_file"

                    if ! grep -q '^[[:space:]]*\(export[[:space:]]\+\)\?PI_CODING_AGENT_DIR=' "$envrc_file"; then
                      # shellcheck disable=SC2016
                      printf '%s\n' 'export PI_CODING_AGENT_DIR="$PWD/.pi/local-agent"' >> "$envrc_file"
                    fi

                    if ! grep -q '^[[:space:]]*\(export[[:space:]]\+\)\?PI_CODING_AGENT_SESSION_DIR=' "$envrc_file"; then
                      # shellcheck disable=SC2016
                      printf '%s\n' 'export PI_CODING_AGENT_SESSION_DIR="$HOME/.pi/agent/sessions"' >> "$envrc_file"
                    fi
        '';
      };
    in
    {
      packages."pi-local-auth" = piLocalAuth;

      checks."pi-local-auth" =
        pkgs.runCommand "pi-local-auth-check" { nativeBuildInputs = [ pkgs.jq ]; }
          ''
            workdir=$(mktemp -d)
            cd "$workdir"

            ${piLocalAuth}/bin/pi-local-auth

            test -f .pi/local-agent/settings.json
            jq -e '.sessionDir == "~/.pi/agent/sessions"' .pi/local-agent/settings.json
            jq -e '.extensions == ["~/.pi/agent/extensions"]' .pi/local-agent/settings.json
            jq -e '.skills == ["~/.pi/agent/skills"]' .pi/local-agent/settings.json
            jq -e '.prompts == ["~/.pi/agent/prompts"]' .pi/local-agent/settings.json
            jq -e '.themes == ["~/.pi/agent/themes"]' .pi/local-agent/settings.json

            grep -Fx 'export PI_CODING_AGENT_DIR="$PWD/.pi/local-agent"' .envrc
            grep -Fx 'export PI_CODING_AGENT_SESSION_DIR="$HOME/.pi/agent/sessions"' .envrc

            case_existing_dir=$(mktemp -d)
            cd "$case_existing_dir"
            printf '%s\n' 'export PI_CODING_AGENT_DIR="custom"' > .envrc
            ${piLocalAuth}/bin/pi-local-auth
            grep -Fx 'export PI_CODING_AGENT_DIR="custom"' .envrc
            grep -Fx 'export PI_CODING_AGENT_SESSION_DIR="$HOME/.pi/agent/sessions"' .envrc
            [ "$(grep -c 'PI_CODING_AGENT_DIR=' .envrc)" -eq 1 ]

            case_existing_session=$(mktemp -d)
            cd "$case_existing_session"
            printf '%s\n' 'PI_CODING_AGENT_SESSION_DIR=custom-session' > .envrc
            ${piLocalAuth}/bin/pi-local-auth
            grep -Fx 'PI_CODING_AGENT_SESSION_DIR=custom-session' .envrc
            grep -Fx 'export PI_CODING_AGENT_DIR="$PWD/.pi/local-agent"' .envrc
            [ "$(grep -c 'PI_CODING_AGENT_SESSION_DIR=' .envrc)" -eq 1 ]

            case_idempotent=$(mktemp -d)
            cd "$case_idempotent"
            ${piLocalAuth}/bin/pi-local-auth
            ${piLocalAuth}/bin/pi-local-auth
            [ "$(grep -c 'PI_CODING_AGENT_DIR=' .envrc)" -eq 1 ]
            [ "$(grep -c 'PI_CODING_AGENT_SESSION_DIR=' .envrc)" -eq 1 ]

            case_existing_settings=$(mktemp -d)
            cd "$case_existing_settings"
            mkdir -p .pi/local-agent
            printf '%s\n' '{"custom":true}' > .pi/local-agent/settings.json
            ${piLocalAuth}/bin/pi-local-auth
            grep -Fx '{"custom":true}' .pi/local-agent/settings.json

            touch "$out"
          '';
    };
}
