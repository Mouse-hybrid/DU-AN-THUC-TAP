param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-f0-9]{40}$')]
    [string]$ExpectedCommit,
    [string]$EvidenceDir = 'D:\POS_SYSTEM_QA\evidence\SPRINT3'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$version = Invoke-RestMethod 'http://160.191.47.17/version'
if ($version.environment -ne 'staging' -or $version.commit -ne $ExpectedCommit) {
    throw 'Staging SHA/environment mismatch; no fixture created.'
}

$credential = Get-Credential -UserName 'qa3_admin' -Message 'QA3 seed password (not recorded)'
if (-not $credential) { throw 'No credential; run not started.' }
$savedPassword = [Environment]::GetEnvironmentVariable('P2_QA_SEED_PASSWORD', 'Process')
$savedCommit = [Environment]::GetEnvironmentVariable('POS_EXPECTED_COMMIT', 'Process')
$env:P2_QA_SEED_PASSWORD = $credential.GetNetworkCredential().Password
$env:POS_EXPECTED_COMMIT = $ExpectedCommit

try {
    New-Item -ItemType Directory -Path $EvidenceDir -Force | Out-Null
    $stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
    $source = Join-Path $EvidenceDir "P2_RWD_006_FRESH_$stamp.json"
    $readOnly = Join-Path $EvidenceDir "P2_RWD_003_010_FRESH_$stamp.json"

    & node (Join-Path $PSScriptRoot 'p2_rwd_006_concurrent_redeem_isolated.mjs') $source
    $firstExit = $LASTEXITCODE
    Write-Host "P2-RWD-006 exit=$firstExit evidence=$source"
    if ($firstExit -ne 0) {
        throw 'P2-RWD-006 did not pass; inspect cleanup_required in JSON before continuing.'
    }
    $first = Get-Content $source -Raw | ConvertFrom-Json
    if ($first.result -ne 'PASSED' -or $first.cleanup_pass -ne $true -or
        $first.build_stable -ne $true -or $first.staging_commit -ne $ExpectedCommit) {
        throw 'P2-RWD-006 assertions, cleanup, or build unstable; stopping before read-only test.'
    }

    & node (Join-Path $PSScriptRoot 'p2_rwd_003_010_historical_readonly.mjs') $source $readOnly
    $secondExit = $LASTEXITCODE
    Write-Host "P2-RWD-003/010 exit=$secondExit evidence=$readOnly"
    if ($secondExit -ne 0) {
        throw 'Read P2-RWD-003/010 JSON for per-case results; Pending/Failed is not a business Pass.'
    }
    $second = Get-Content $readOnly -Raw | ConvertFrom-Json
    if ($second.result -ne 'PASSED' -or $second.build_stable -ne $true -or
        $second.source_run_id -ne $first.run_id) {
        throw 'Read-only result does not match source run; inspect JSON.'
    }
    Write-Host "[P2 Rewards] PASS: source=$($first.run_id); read-only=$($second.run_id); SHA=$ExpectedCommit"
} finally {
    if ($null -eq $savedPassword) {
        Remove-Item Env:P2_QA_SEED_PASSWORD -ErrorAction SilentlyContinue
    } else { $env:P2_QA_SEED_PASSWORD = $savedPassword }
    if ($null -eq $savedCommit) {
        Remove-Item Env:POS_EXPECTED_COMMIT -ErrorAction SilentlyContinue
    } else { $env:POS_EXPECTED_COMMIT = $savedCommit }
    $credential = $null
}
