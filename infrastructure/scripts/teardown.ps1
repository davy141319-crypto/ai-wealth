# ============================================================================
# AI Wealth — Tear down local stack (PowerShell)
# Stops containers, removes volumes (DESTRUCTIVE — pass -IncludeVolumes to wipe data).
# Usage:
#   ./infrastructure/scripts/teardown.ps1            # stop only
#   ./infrastructure/scripts/teardown.ps1 -IncludeVolumes  # stop + wipe data
# ============================================================================
[CmdletBinding()]
param(
    [switch]$IncludeVolumes
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path "$PSScriptRoot/../.."

Write-Host "==> Stopping docker compose stack" -ForegroundColor Cyan
if ($IncludeVolumes) {
    docker compose -f "$repoRoot/docker-compose.yml" down -v
} else {
    docker compose -f "$repoRoot/docker-compose.yml" down
}

if ($IncludeVolumes) {
    Write-Host "==> Removing named volumes" -ForegroundColor Cyan
    docker volume rm aiwealth_postgres_data aiwealth_redis_data -f
}

Write-Host "==> Done." -ForegroundColor Green
