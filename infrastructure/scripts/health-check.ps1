# ============================================================================
# AI Wealth — Health verification script (PowerShell)
# Probes all running services' health endpoints and reports PASS/FAIL.
# Usage:
#   ./infrastructure/scripts/health-check.ps1
# ============================================================================
[CmdletBinding()]
param()

$targets = @(
    @{ Name = "API";        Url = "http://localhost:4000/api/health" },
    @{ Name = "Worker";     Url = "http://localhost:4001/health" },
    @{ Name = "Blockchain";  Url = "http://localhost:4002/health" },
    @{ Name = "Web";         Url = "http://localhost:3000/" },
    @{ Name = "Admin";      Url = "http://localhost:3001/" }
)

$allOk = $true
foreach ($t in $targets) {
    try {
        $resp = Invoke-WebRequest -Uri $t.Url -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
        if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500) {
            Write-Host "  [PASS] $($t.Name.PadRight(10)) $($t.Url) -> HTTP $($resp.StatusCode)" -ForegroundColor Green
        } else {
            Write-Host "  [FAIL] $($t.Name.PadRight(10)) $($t.Url) -> HTTP $($resp.StatusCode)" -ForegroundColor Red
            $allOk = $false
        }
    } catch {
        Write-Host "  [FAIL] $($t.Name.PadRight(10)) $($t.Url) -> $($_.Exception.Message)" -ForegroundColor Red
        $allOk = $false
    }
}

if (-not $allOk) { exit 1 }
Write-Host "All health probes passed." -ForegroundColor Green
