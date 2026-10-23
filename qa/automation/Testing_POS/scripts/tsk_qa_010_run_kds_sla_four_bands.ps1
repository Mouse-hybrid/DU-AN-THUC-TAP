param(
  [string]$BaseUrl = 'http://160.191.47.17',
  [string]$ExpectedCommit = '',
  [switch]$CleanupSmoke
)

$ErrorActionPreference = 'Stop'
$base = $BaseUrl.TrimEnd('/')
if ($base -ne 'http://160.191.47.17') { throw 'TSK-QA-010 SLA run is restricted to approved staging' }
if ($ExpectedCommit -and $ExpectedCommit -notmatch '^[0-9a-fA-F]{7,40}$') {
  throw 'ExpectedCommit must be a 7-40 character Git commit prefix'
}
$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\DES-QA-06'
$logPrefix = if ($CleanupSmoke) { 'TSK_QA_010_CLEANUP_SMOKE' } else { 'TSK_QA_010_KDS_SLA_FOUR_BANDS' }
$evidenceLog = Join-Path $evidenceDir ("{0}_{1}.log" -f $logPrefix, (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
$unfixedCommit = '1c41cce58de2d9637f318e11cddae424f76d9278'
$observedCommit = [string](Invoke-RestMethod -Method Get -Uri "$base/version" -TimeoutSec 20).commit
if ($observedCommit -notmatch '^[0-9a-f]{40}$') { throw 'GET /version missing full commit' }
if ($ExpectedCommit -and -not $observedCommit.StartsWith($ExpectedCommit, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Staging commit $observedCommit differs from expected $ExpectedCommit; no fixture created"
}
if ($observedCommit -eq $unfixedCommit) {
  New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
  '[TSK-QA-010] PENDING retest: staging 1c41cce predates PR #43 WARNING badge fix; no ticket created' |
    Tee-Object -FilePath $evidenceLog
  Write-Host "TSK-QA-010 Terminal evidence: $evidenceLog"
  exit 0
}
$credential = Get-Credential -UserName 'kitchen' -Message 'Shared staging PIN for one isolated 15-minute KDS SLA UI run and fixture cleanup'
$exitCode = 1
$preflightBlocked = $false

try {
  if (-not $credential) { throw 'Credential prompt cancelled' }
  $pin = $credential.GetNetworkCredential().Password
  if (-not $pin) { throw 'Staging PIN is empty' }
  New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
  $before = (Invoke-RestMethod -Method Get -Uri "$base/version" -TimeoutSec 20).commit
  if ($before -ne $observedCommit) { throw "Staging build changed before SLA run: $observedCommit -> $before" }
  $mode = if ($CleanupSmoke) { 'short cleanup smoke' } else { 'four real-time bands' }
  "[TSK-QA-010] SLA UI staging start $($before.Substring(0, 12)); one own ticket, $mode" |
    Tee-Object -FilePath $evidenceLog

  # Read-only fixture gate: print the reason for a pending/skip before Playwright starts.
  $loginBody = @{ username = 'waiter'; password = $pin } | ConvertTo-Json -Compress
  $auth = Invoke-RestMethod -Method Post -Uri "$base/api/v1/auth/login" -Body $loginBody `
    -ContentType 'application/json' -TimeoutSec 20
  $headers = @{ Authorization = "Bearer $($auth.access_token)" }
  [object[]]$tables = Invoke-RestMethod -Method Get -Uri "$base/api/v1/tables" -Headers $headers -TimeoutSec 20
  [object[]]$menu = Invoke-RestMethod -Method Get -Uri "$base/api/v1/menu?available_only=true" -Headers $headers -TimeoutSec 20
  $qaTables = @($tables | Where-Object { $_.code -match '^B[1-4]$' })
  $availableTables = @($qaTables | Where-Object { $_.status -eq 'AVAILABLE' })
  $mappedItems = @($menu | Where-Object { $_.is_available -and $_.station_id })
  $tableSummary = ($qaTables | ForEach-Object { "$($_.code):$($_.status)" }) -join ', '
  "[TSK-QA-010] Fixture gate: B1-B4 [$tableSummary]; available $($availableTables.Count); menu $($menu.Count); mapped $($mappedItems.Count)" |
    Tee-Object -FilePath $evidenceLog -Append
  if ($availableTables.Count -eq 0 -or $mappedItems.Count -eq 0) {
    $preflightBlocked = $true
    '[TSK-QA-010] PENDING: fixture gate unavailable; UI test not executed and no ticket created' |
      Tee-Object -FilePath $evidenceLog -Append
  }
  $auth = $null
  $headers = $null
  $loginBody = $null

  if ($preflightBlocked) {
    $exitCode = 0
  } else {
    $env:BASE_URL = $base
    $env:KDS_STAGING_PIN = $pin
    if ($CleanupSmoke) { $env:KDS_CLEANUP_SMOKE = 'true' }
    Push-Location (Split-Path -Parent $PSScriptRoot)
    try {
      $priorConsole = [Console]::OutputEncoding
      $priorOutput = $OutputEncoding
      [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
      $OutputEncoding = [Console]::OutputEncoding
      try {
        & npx playwright test test_playwright_version/tsk_qa_010_kds_sla_four_bands.spec.ts --project=chromium 2>&1 |
          Tee-Object -FilePath $evidenceLog -Append
        $exitCode = $LASTEXITCODE
      } finally {
        [Console]::OutputEncoding = $priorConsole
        $OutputEncoding = $priorOutput
      }
    } finally { Pop-Location }
  }

  $after = (Invoke-RestMethod -Method Get -Uri "$base/version" -TimeoutSec 20).commit
  if ($after -ne $before) {
    '[TSK-QA-010] INCONCLUSIVE: staging build changed during preflight/run' |
      Tee-Object -FilePath $evidenceLog -Append
    $exitCode = 1
  }
} finally {
  Remove-Item Env:BASE_URL, Env:KDS_STAGING_PIN, Env:KDS_CLEANUP_SMOKE -ErrorAction SilentlyContinue
  $pin = $null
  $credential = $null
  $auth = $null
  $headers = $null
  $loginBody = $null
}

Write-Host "TSK-QA-010 Terminal evidence: $evidenceLog"
if ($preflightBlocked) {
  Write-Host '[TSK-QA-010] Fixture Pending. Playwright was not started; no new video or business PASS.'
} else {
  if ($CleanupSmoke) {
    Write-Host '[TSK-QA-010] Short UI handoff and cleanup smoke only; four SLA bands, Expeditor and invoice export/print remain untested.'
  } else {
    Write-Host '[TSK-QA-010] Check four-band and READY/billing screenshots plus cleanup. Expeditor and invoice export/print remain untested.'
  }
}
exit $exitCode
