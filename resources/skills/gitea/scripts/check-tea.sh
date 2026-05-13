#!/usr/bin/env bash
# check-tea.sh - Validate tea CLI installation, login configuration, and repo context
# Exit codes: 0 = ready, 1 = tea not installed, 2 = no logins, 3 = no repo context

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

status=0

# 1. Check tea installation
if command -v tea &>/dev/null; then
    version=$(tea --version 2>/dev/null | head -1)
    echo -e "${GREEN}[OK]${NC} tea is installed: ${version}"
else
    echo -e "${RED}[FAIL]${NC} tea is not installed"
    echo "  Install: brew install tea (macOS) or see https://gitea.com/gitea/tea"
    exit 1
fi

# 2. Check logins
login_count=$(tea logins ls --output csv 2>/dev/null | tail -n +2 | wc -l | tr -d ' ')
if [ "$login_count" -gt 0 ]; then
    echo -e "${GREEN}[OK]${NC} ${login_count} login(s) configured:"
    tea logins ls --output simple 2>/dev/null | sed 's/^/  /'
else
    echo -e "${RED}[FAIL]${NC} No logins configured"
    echo "  Run: tea logins add --name <name> --url <url> --token <token>"
    status=2
fi

# 3. Check default login
if [ "$login_count" -gt 0 ]; then
    default_login=$(tea logins ls --output csv 2>/dev/null | tail -n +2 | grep -i ',true' | head -1 || true)
    if [ -n "$default_login" ]; then
        echo -e "${GREEN}[OK]${NC} Default login is set"
    else
        echo -e "${YELLOW}[WARN]${NC} No default login set"
        echo "  Run: tea logins default <name>"
    fi
fi

# 4. Check repo context
if git rev-parse --is-inside-work-tree &>/dev/null; then
    echo -e "${GREEN}[OK]${NC} Inside a git repository: $(basename $(git rev-parse --show-toplevel))"

    # Check for Gitea remotes
    remotes=$(git remote -v 2>/dev/null | grep -i 'fetch' || true)
    if [ -n "$remotes" ]; then
        echo -e "  Remotes:"
        echo "$remotes" | sed 's/^/    /'

        # Try to match remotes against configured logins
        if [ "$login_count" -gt 0 ]; then
            matched=false
            while IFS= read -r login_url; do
                login_url=$(echo "$login_url" | tr -d ' ')
                if echo "$remotes" | grep -qi "$(echo "$login_url" | sed 's|https\?://||;s|/$||')" 2>/dev/null; then
                    echo -e "  ${GREEN}[OK]${NC} Remote matches a configured login"
                    matched=true
                    break
                fi
            done < <(tea logins ls --output csv 2>/dev/null | tail -n +2 | cut -d',' -f2)

            if [ "$matched" = false ]; then
                echo -e "  ${YELLOW}[WARN]${NC} No remote matches a configured Gitea login"
                echo "    Use --login and --repo flags to specify target"
            fi
        fi
    else
        echo -e "  ${YELLOW}[WARN]${NC} No remotes configured"
    fi
else
    echo -e "${YELLOW}[INFO]${NC} Not inside a git repository"
    echo "  Use --repo owner/repo and --login flags to specify target"
    if [ "$status" -eq 0 ]; then
        status=3
    fi
fi

# 5. Check whoami
if [ "$login_count" -gt 0 ]; then
    if user=$(tea whoami 2>/dev/null); then
        echo -e "${GREEN}[OK]${NC} Authenticated as: ${user}"
    else
        echo -e "${YELLOW}[WARN]${NC} Could not verify authentication (server may be unreachable)"
    fi
fi

echo ""
if [ "$status" -eq 0 ]; then
    echo -e "${GREEN}Ready to use tea CLI${NC}"
else
    echo -e "${YELLOW}Some checks failed - see above${NC}"
fi

exit $status
