#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: forgejo-comment-screenshot.sh --repo OWNER/REPO --pr N --file IMAGE.png --body BODY [options]

Options:
  --base-url URL       Forgejo base URL (default: tea login URL for --login)
  --login NAME         tea login name to read URL/token from ~/.config/tea/config.yml
  --token-env NAME     Environment variable containing token (default: FORGEJO_TOKEN)
  --name NAME          Attachment filename (default: basename of --file)
  --body BODY          Markdown body. Use {url} placeholder for uploaded image URL.
  --repo OWNER/REPO    Repository slug
  --pr N               Pull request / issue number
  --file PATH          PNG/JPG screenshot path
EOF
}

repo=""; pr=""; file=""; body=""; base_url=""; login=""; token_env="FORGEJO_TOKEN"; name=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) repo="$2"; shift 2 ;;
    --pr) pr="$2"; shift 2 ;;
    --file) file="$2"; shift 2 ;;
    --body) body="$2"; shift 2 ;;
    --base-url) base_url="$2"; shift 2 ;;
    --login) login="$2"; shift 2 ;;
    --token-env) token_env="$2"; shift 2 ;;
    --name) name="$2"; shift 2 ;;
    --help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

[ -n "$repo" ] && [ -n "$pr" ] && [ -n "$file" ] && [ -n "$body" ] || { usage; exit 2; }
[ -f "$file" ] || { echo "file not found: $file" >&2; exit 1; }
case "$file" in *.png|*.jpg|*.jpeg|*.webp) ;; *) echo "screenshot should be an image file: $file" >&2; exit 1 ;; esac
[ -n "$name" ] || name="$(basename "$file")"

if [ -n "$login" ]; then
  config="${XDG_CONFIG_HOME:-$HOME/.config}/tea/config.yml"
  [ -f "$config" ] || { echo "tea config not found: $config" >&2; exit 1; }
  readarray -t login_values < <(python3 - "$config" "$login" <<'PY'
import sys
from pathlib import Path
config = Path(sys.argv[1]).read_text().splitlines()
wanted = sys.argv[2]
current = None
url = token = None
for line in config:
    stripped = line.strip()
    if stripped.startswith('- name:'):
        current = stripped.split(':', 1)[1].strip()
    elif current == wanted and stripped.startswith('url:'):
        url = stripped.split(':', 1)[1].strip()
    elif current == wanted and stripped.startswith('token:'):
        token = stripped.split(':', 1)[1].strip()
if url: print(url)
if token: print(token)
PY
  )
  [ -n "$base_url" ] || base_url="${login_values[0]:-}"
  if [ -z "${!token_env:-}" ] && [ -n "${login_values[1]:-}" ]; then
    export "$token_env=${login_values[1]}"
  fi
fi

[ -n "$base_url" ] || { echo "--base-url or --login is required" >&2; exit 1; }
token="${!token_env:-}"
[ -n "$token" ] || { echo "$token_env is required" >&2; exit 1; }

owner="${repo%%/*}"; repo_name="${repo#*/}"
encoded_name="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$name")"
asset_json="$(mktemp)"; comment_json="$(mktemp)"; response_json="$(mktemp)"
trap 'rm -f "$asset_json" "$comment_json" "$response_json"' EXIT

curl -fsS \
  -H "Authorization: token $token" \
  -F "attachment=@${file}" \
  "${base_url%/}/api/v1/repos/${owner}/${repo_name}/issues/${pr}/assets?name=${encoded_name}" \
  -o "$asset_json"
asset_url="$(jq -r '.browser_download_url' "$asset_json")"
[ -n "$asset_url" ] && [ "$asset_url" != "null" ] || { echo "upload did not return browser_download_url" >&2; cat "$asset_json" >&2; exit 1; }

comment_body="${body//\{url\}/$asset_url}"
jq -n --arg body "$comment_body" '{body:$body}' > "$comment_json"
curl -fsS \
  -X POST \
  -H "Authorization: token $token" \
  -H "Content-Type: application/json" \
  --data @"$comment_json" \
  "${base_url%/}/api/v1/repos/${owner}/${repo_name}/issues/${pr}/comments" \
  -o "$response_json"

jq -r '"comment_id=\(.id)\ncomment_url=\(.html_url // "")"' "$response_json"
echo "asset_url=$asset_url"
