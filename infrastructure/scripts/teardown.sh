#!/usr/bin/env bash
# ============================================================================
# AI Wealth — Tear down local stack (Bash)
# Usage:
#   ./infrastructure/scripts/teardown.sh             # stop only
#   ./infrastructure/scripts/teardown.sh --volumes    # stop + wipe data
# ============================================================================
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

if [ "${1:-}" = "--volumes" ]; then
    echo "==> Stopping docker compose stack and removing volumes"
    docker compose -f docker-compose.yml down -v
    docker volume rm aiwealth_postgres_data aiwealth_redis_data -f || true
else
    echo "==> Stopping docker compose stack (volumes retained)"
    docker compose -f docker-compose.yml down
fi
echo "==> Done."
