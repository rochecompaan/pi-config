#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bootstrap_script="$script_dir/bootstrap-tilt-worktree-env.sh"

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
ready_resource="$(get_value TILT_WORKTREE_READY_RESOURCE)"
ready_timeout="$(get_value TILT_WORKTREE_READY_TIMEOUT)"
if [ -z "$ready_resource" ]; then
  ready_resource="deploy/server"
fi
if [ -z "$ready_timeout" ]; then
  ready_timeout="5s"
fi

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

if ! command -v tilt >/dev/null 2>&1; then
  echo "Tilt is required but the tilt command is not available. Enter the project toolchain first." >&2
  exit 1
fi

if ! command -v kubectl >/dev/null 2>&1; then
  echo "kubectl is required but is not available. Enter the project toolchain first." >&2
  exit 1
fi

if ! tilt --port "$tilt_port" logs >/dev/null 2>&1; then
  cat >&2 <<MSG
Tilt is required but the configured Tilt instance is not running.
Configured TILT_PORT=$tilt_port
Configured $namespace_env=$namespace
Start it with your wrapper for: tilt-worktree.sh up
Inspect it with your wrapper for: tilt-worktree.sh logs
MSG
  exit 1
fi

if ! kubectl -n "$namespace" wait --for=condition=Available "$ready_resource" --timeout="$ready_timeout" >/dev/null 2>&1; then
  cat >&2 <<MSG
Tilt is running, but $ready_resource is not ready.
Configured TILT_PORT=$tilt_port
Configured $namespace_env=$namespace
Inspect Tilt logs and pods before treating this as a code test failure.
Suggested commands:
  tilt-worktree.sh logs
  kubectl -n $namespace get pods
MSG
  exit 1
fi

echo "Tilt is running and $ready_resource is ready in namespace $namespace."
