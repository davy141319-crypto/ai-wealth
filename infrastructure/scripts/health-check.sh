#!/usr/bin/env bash
# ============================================================================
# AI Wealth — Health verification script (Bash)
# Probes all running services' health endpoints and reports PASS/FAIL.
# Usage:
#   ./infrastructure/scripts/health-check.sh
# ============================================================================
set -uo pipefail

TARGETS=(
    "API        http://localhost:4000/api/health"
    "Worker     http://localhost:4001/health"
    "Blockchain http://localhost:4002/health"
    "Web        http://localhost:3000/"
    "Admin      http://localhost:3001/"
)

allok=1
for entry in "${TARGETS[@]}"; do
    name=${entry%% *}
    url=${entry##* }
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$url" 2>/dev/null || echo "000")
    if [[ "$code" =~ ^2 ]] || [[ "$code" =~ ^3 ]]; then
        echo "  [PASS] $name $(printf '%-10s' '') $url -> HTTP $code"
    else
        echo "  [FAIL] $name $(printf '%-10s' '') $url -> HTTP $code"
        allok=0
    fi
done

if [ "$allok" -ne 1 ]; then exit 1; fi
echo "All health probes passed."
