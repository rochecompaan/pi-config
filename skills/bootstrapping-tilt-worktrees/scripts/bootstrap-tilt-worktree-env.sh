#!/usr/bin/env bash
set -euo pipefail

env_file="${TILT_WORKTREE_ENV_FILE:-.env}"

strip_outer_quotes() {
  local value="$1"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s' "$value"
}

get_env_file_value() {
  local key="$1"
  if [ -f "$env_file" ]; then
    strip_outer_quotes "$(sed -n "s/^${key}=//p" "$env_file" | tail -n 1)"
  fi
}

get_config_value() {
  local key="$1"
  local default_value="$2"
  local current_value="${!key:-}"
  if [ -n "$current_value" ]; then
    printf '%s' "$current_value"
    return
  fi
  current_value="$(get_env_file_value "$key")"
  if [ -n "$current_value" ]; then
    printf '%s' "$current_value"
    return
  fi
  printf '%s' "$default_value"
}

sanitize_namespace_part() {
  local raw="$1"
  printf '%s' "$raw" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g'
}

valid_port() {
  local port="$1"
  [[ "$port" =~ ^[0-9]+$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ]
}

port_available() {
  local port="$1"
  valid_port "$port" || return 1
  ! (echo >/dev/tcp/127.0.0.1/"$port") >/dev/null 2>&1
}

append_env_value() {
  local key="$1"
  local value="$2"
  mkdir -p "$(dirname "$env_file")"
  touch "$env_file"
  if [ -s "$env_file" ] && [ "$(tail -c1 "$env_file" | wc -l)" -eq 0 ]; then
    printf '\n' >> "$env_file"
  fi
  printf '%s=%s\n' "$key" "$value" >> "$env_file"
}

validate_var_name() {
  local name="$1"
  if ! [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "Invalid environment variable name: $name" >&2
    exit 1
  fi
}

namespace_env="$(get_config_value TILT_WORKTREE_NAMESPACE_ENV TILT_WORKTREE_NAMESPACE)"
namespace_prefix="$(sanitize_namespace_part "$(get_config_value TILT_WORKTREE_NAMESPACE_PREFIX tilt)")"
port_specs="$(get_config_value TILT_WORKTREE_PORT_SPECS 'TILT_PORT:10380')"
validate_var_name "$namespace_env"
if [ -z "$namespace_prefix" ]; then
  namespace_prefix="tilt"
fi

worktree_name="$(basename "$PWD")"
namespace_suffix="$(sanitize_namespace_part "$worktree_name" | cut -c1-40 | sed -E 's/-+$//')"
if [ -z "$namespace_suffix" ]; then
  namespace_suffix="dev"
fi
namespace_default="$(sanitize_namespace_part "$namespace_prefix-$namespace_suffix" | cut -c1-63 | sed -E 's/-+$//')"

missing_port_specs=()
for spec in $port_specs; do
  key="${spec%%:*}"
  base="${spec#*:}"
  validate_var_name "$key"
  if ! valid_port "$base"; then
    echo "Invalid port base in TILT_WORKTREE_PORT_SPECS: $spec" >&2
    exit 1
  fi
  existing_value="$(get_env_file_value "$key")"
  if [ -z "$existing_value" ]; then
    missing_port_specs+=("$key:$base")
  elif ! valid_port "$existing_value"; then
    echo "Invalid existing port value in $env_file: $key=$existing_value" >&2
    exit 1
  fi
done

chosen_ports=()
if [ "${#missing_port_specs[@]}" -gt 0 ]; then
  offset=0
  while true; do
    candidate_ok=true
    for spec in "${missing_port_specs[@]}"; do
      base="${spec#*:}"
      candidate="$((base + offset))"
      if ! valid_port "$candidate"; then
        echo "No valid ports remain for spec: $spec" >&2
        exit 1
      fi
      if ! port_available "$candidate"; then
        candidate_ok=false
        break
      fi
    done

    if [ "$candidate_ok" = true ]; then
      for spec in "${missing_port_specs[@]}"; do
        key="${spec%%:*}"
        base="${spec#*:}"
        chosen_ports+=("$key:$((base + offset))")
      done
      break
    fi

    offset="$((offset + 1))"
    if [ "$offset" -gt 1000 ]; then
      echo "Could not find available ports for specs: $port_specs" >&2
      exit 1
    fi
  done
fi

if [ -z "$(get_env_file_value "$namespace_env")" ]; then
  append_env_value "$namespace_env" "$namespace_default"
fi

for chosen in "${chosen_ports[@]}"; do
  key="${chosen%%:*}"
  value="${chosen#*:}"
  if [ -z "$(get_env_file_value "$key")" ]; then
    append_env_value "$key" "$value"
  fi
done

echo "Tilt worktree environment ready in $env_file:"
echo "  $namespace_env=$(get_env_file_value "$namespace_env")"
for spec in $port_specs; do
  key="${spec%%:*}"
  echo "  $key=$(get_env_file_value "$key")"
done
