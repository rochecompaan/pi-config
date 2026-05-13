#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bootstrap_script="$script_dir/bootstrap-tilt-worktree-env.sh"

action="${1:-}"
if [ -z "$action" ]; then
  echo "Usage: $0 up|logs|down [extra tilt args]" >&2
  exit 2
fi
shift || true

"$bootstrap_script" >/dev/null

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

get_value() {
  local key="$1"
  local current_value="${!key:-}"
  if [ -n "$current_value" ]; then
    printf '%s' "$current_value"
    return
  fi
  get_env_file_value "$key"
}

namespace_env="$(get_value TILT_WORKTREE_NAMESPACE_ENV)"
if [ -z "$namespace_env" ]; then
  namespace_env="TILT_WORKTREE_NAMESPACE"
fi
namespace="$(get_value "$namespace_env")"
tilt_port="$(get_value TILT_PORT)"

valid_port() {
  local port="$1"
  [[ "$port" =~ ^[0-9]+$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ]
}

if [ -z "$tilt_port" ]; then
  echo "TILT_PORT is required in $env_file" >&2
  exit 1
fi
if ! valid_port "$tilt_port"; then
  echo "Invalid TILT_PORT: $tilt_port" >&2
  exit 1
fi
if [ -z "$namespace" ]; then
  echo "$namespace_env is required in $env_file" >&2
  exit 1
fi

case "$action" in
  up)
    kubectl create namespace "$namespace" --dry-run=client -o yaml | kubectl apply -f -
    exec tilt up --port "$tilt_port" --namespace "$namespace" "$@"
    ;;
  logs)
    exec tilt --port "$tilt_port" logs "$@"
    ;;
  down)
    exec tilt down --namespace "$namespace" "$@"
    ;;
  *)
    echo "Unknown action: $action" >&2
    echo "Usage: $0 up|logs|down [extra tilt args]" >&2
    exit 2
    ;;
esac
