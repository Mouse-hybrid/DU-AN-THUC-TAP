# QA-only staging table readiness utility.
# No bulk reset, no database access, no payment, no automatic closure.
# Usage:
#   $env:POS_QA_WAITER_TOKEN = '<valid waiter bearer token>'
#   .\qa-table-readiness.ps1
#   .\qa-table-readiness.ps1 -TableCode B3 -MarkClean -WhatIf
#   .\qa-table-readiness.ps1 -TableCode B3 -MarkClean -Confirm
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [string]$BaseUrl = 'http://160.191.47.17',
    [ValidatePattern('^B[1-6]$')]
    [string]$TableCode,
    [switch]$MarkClean
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$token = $env:POS_QA_WAITER_TOKEN
if ([string]::IsNullOrWhiteSpace($token)) {
    throw 'Missing POS_QA_WAITER_TOKEN. Set it in this PowerShell session (never commit it).'
}

$base = $BaseUrl.TrimEnd('/')
$headers = @{ Authorization = "Bearer $token" }

try {
    $tables = Invoke-RestMethod -Method Get -Uri "$base/api/v1/tables" -Headers $headers -TimeoutSec 20
} catch {
    throw "Cannot read staging tables. Check base URL, token role and connectivity. $($_.Exception.Message)"
}

$qaTables = @($tables | Where-Object { $_.code -match '^B[1-6]$' } | Sort-Object code)
if ($qaTables.Count -eq 0) { throw 'No B1-B6 table records found; no changes made.' }

Write-Host 'Staging QA table readiness (read-only inventory):'
$qaTables | Select-Object code, status, current_session_id, guest_count | Format-Table -AutoSize

if (-not $MarkClean) {
    Write-Host 'Audit completed. No table was modified.'
    Write-Host 'OCCUPIED: inspect Order and finish valid billing/pay/close workflow, or ask BE/DevOps for approved QA reset.'
    Write-Host 'CLEANING: use -TableCode Bx -MarkClean -Confirm only for an authorized QA table.'
    return
}

if ([string]::IsNullOrWhiteSpace($TableCode)) {
    throw 'For -MarkClean, provide a specific -TableCode B1..B6.'
}

$table = @($qaTables | Where-Object { $_.code -eq $TableCode })
if ($table.Count -ne 1) { throw "Table $TableCode not found uniquely; no changes made." }
$table = $table[0]

if ($table.status -ne 'CLEANING') {
    throw "Refusing to mark $TableCode clean: current status is '$($table.status)', not CLEANING. No changes made."
}

$target = "$base/api/v1/tables/$($table.id)/mark-clean"
if ($PSCmdlet.ShouldProcess("$TableCode ($($table.id))", 'Mark QA table CLEANING -> AVAILABLE')) {
    $requestHeaders = @{
        Authorization = "Bearer $token"
        'Idempotency-Key' = [guid]::NewGuid().ToString()
        'Content-Type' = 'application/json'
    }
    try {
        $null = Invoke-RestMethod -Method Post -Uri $target -Headers $requestHeaders -TimeoutSec 20
        $afterResponse = Invoke-RestMethod -Method Get -Uri "$base/api/v1/tables" -Headers $headers -TimeoutSec 20
        $after = @($afterResponse |
            Where-Object { $_.code -eq $TableCode })
        if ($after.Count -ne 1 -or $after[0].status -ne 'AVAILABLE') {
            throw 'POST succeeded but subsequent GET did not confirm AVAILABLE. Inspect backend response.'
        }
        Write-Host "Verified $TableCode is AVAILABLE."
    } catch {
        throw "Mark-clean failed or could not be verified: $($_.Exception.Message)"
    }
}
