#!/usr/bin/env bash
# ============================================================================
# AI Wealth — Local dev bootstrap (Bash)
# Brings up postgres + redis, runs prisma migrate, verifies health.
# Usage:
#   ./infrastructure/scripts/dev-up.sh
# ============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

echo "==> Starting postgres + redis"
docker compose -f docker-compose.yml up -d postgres redis

echo "==> Waiting for postgres to be healthy"
for _ in $(seq 1 30); do
    status=$(docker inspect --format='{{.State.Health.Status}}' aiwealth-postgres 2>/dev/null || true)
    if [ "$status" = "healthy" ]; then break; fi
    sleep 2
done
if [ "$status" != "healthy" ]; then
    echo "postgres did not become healthy" >&2
    exit 1
fi

echo "==> Running prisma migrate deploy"
( cd packages/database && pnpm exec prisma migrate deploy )

if [ "${1:-}" != "--skip-apps" ]; then
    echo "==> Starting api + worker + blockchain"
    docker compose -f docker-compose.yml up -d api worker blockchain
fi

echo "==> Done. Health endpoints:"
echo "    API:        http://localhost:4000/api/health"
echo "    API docs:   http://localhost:4000/api/docs"
echo "    Worker:     http://localhost:4001/health"
echo "    Blockchain: http://localhost:4002/health"
echo "    Postgres:   localhost:5432"
echo "    Redis:      localhost:6379"
