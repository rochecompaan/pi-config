#!/usr/bin/env bash
set -eu

local_agent_dir=".pi/local-agent"
settings_file="$local_agent_dir/settings.json"
envrc_file=".envrc"

mkdir -p "$local_agent_dir"

write_fallback_settings() {
  cat <<'EOF'
{
  "sessionDir": "~/.pi/agent/sessions",
  "extensions": ["~/.pi/agent/extensions"],
  "skills": ["~/.pi/agent/skills"],
  "prompts": ["~/.pi/agent/prompts"],
  "themes": ["~/.pi/agent/themes"]
}
EOF
}

if [ ! -e "$settings_file" ]; then
  settings_template="${PI_LOCAL_AUTH_SETTINGS_TEMPLATE:-$HOME/.pi/agent/settings.json}"

  if [ -f "$settings_template" ]; then
    jq '. + {
      sessionDir: "~/.pi/agent/sessions",
      extensions: ["~/.pi/agent/extensions"],
      skills: ["~/.pi/agent/skills"],
      prompts: ["~/.pi/agent/prompts"],
      themes: ["~/.pi/agent/themes"]
    }' "$settings_template" > "$settings_file"
  else
    write_fallback_settings > "$settings_file"
  fi
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
