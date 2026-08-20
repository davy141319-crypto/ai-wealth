# ============================================================================
# AI Wealth — Local dev bootstrap (PowerShell)
# Brings up postgres + redis, then runs prisma migrate + verifies health.
# Usage:
#   ./infrastructure/scripts/dev-up.ps1
# ============================================================================
[CmdletBinding()]
param(
    [switch]$SkipApps
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path "$PSScriptRoot/../.."

Write-Host "==> Starting postgres + redis" -ForegroundColor Cyan
docker compose -f "$repoRoot/docker-compose.yml" up -d postgres redis
if ($LASTEXITCODE -ne 0) { throw "docker compose up failed (is Docker Desktop running?)" }

Write-Host "==> Waiting for postgres to be healthy" -ForegroundColor Cyan
for ($i = 0; $i -lt 30; $i++) {
    $out = docker inspect --format='{{.State.Health.Status}}' aiwealth-postgres 2>$null
    if ($out -eq "healthy") { break }
    Start-Sleep -Seconds 2
}
if ($out -ne "healthy") { throw "postgres did not become healthy" }

Write-Host "==> Running prisma migrate deploy" -ForegroundColor Cyan
Push-Location "$repoRoot/packages/database"
try {
    pnpm exec prisma migrate deploy
} finally {
    Pop-Location
}

if (-not $SkipApps) {
    Write-Host "==> Starting api + worker + blockchain" -ForegroundColor Cyan
    docker compose -f "$repoRoot/docker-compose.yml" up -d api worker blockchain
}

Write-Host "==> Done. Health endpoints:" -ForegroundColor Green
Write-Host "    API:        http://localhost:4000/api/health"
Write-Host "    API docs:   http://localhost:4000/api/docs"
Write-Host "    Worker:     http://localhost:4001/health"
Write-Host "    Blockchain: http://localhost:4002/health"
Write-Host "    Postgres:   localhost:5432"
Write-Host "    Redis:      localhost:6379"
