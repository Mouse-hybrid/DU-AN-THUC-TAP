param(
  [string]$BaseUrl = 'http://160.191.47.17',
  [string]$ExpectedCommit = '',
  [switch]$RequireUiWebSocket
)

$ErrorActionPreference = 'Stop'
$base = $BaseUrl.TrimEnd('/')
if ($base -ne 'http://160.191.47.17') { throw 'TC_EXT_017 run is restricted to approved staging' }
if ($ExpectedCommit -and $ExpectedCommit -notmatch '^[0-9a-f]{7,40}$') {
  throw 'ExpectedCommit must be a Git commit prefix (7-40 hex characters)'
}
$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\AFG_POS'
$evidenceLog = Join-Path $evidenceDir ("TC_EXT_017_UI_RECONNECT_{0}.log" -f (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
$oldStagingCommit = '1c41cce58de2d9637f318e11cddae424f76d9278'
$observedCommit = [string](Invoke-RestMethod -Method Get -Uri "$base/version" -TimeoutSec 20).commit
if ($observedCommit -notmatch '^[0-9a-f]{40}$') { throw 'GET /version missing full commit' }
if ($ExpectedCommit -and -not $observedCommit.StartsWith($ExpectedCommit)) {
  throw "Staging commit $observedCommit differs from expected $ExpectedCommit"
}
if ($observedCommit -eq $oldStagingCommit) {
  New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
  "[TC_EXT_017] PENDING: staging $($observedCommit.Substring(0, 12)) predates PR #42; Kitchen UI WebSocket not deployed; no fixture created" |
    Tee-Object -FilePath $evidenceLog
  Write-Host "TC_EXT_017 UI Terminal evidence: $evidenceLog"
  exit 0
}
$credential = Get-Credential -UserName 'kitchen' -Message 'Shared staging PIN for one isolated TC_EXT_017 UI reconnect run'
$exitCode = 1

try {
  if (-not $credential) { throw 'Credential prompt cancelled' }
  $pin = $credential.GetNetworkCredential().Password
  if (-not $pin) { throw 'Staging PIN is empty' }
  New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
  $before = [string](Invoke-RestMethod -Method Get -Uri "$base/version" -TimeoutSec 20).commit
  if ($before -ne $observedCommit) { throw "Staging build changed before test: $observedCommit -> $before" }
  "[TC_EXT_017] UI reconnect staging $($before.Substring(0, 12)); own B1-B4 order only" |
    Tee-Object -FilePath $evidenceLog

  $env:BASE_URL = $base
  $env:TC_EXT_017_STAGING_PIN = $pin
  $env:TC_EXT_017_EXPECT_UI_WS = 'true'
  Push-Location (Split-Path -Parent $PSScriptRoot)
  try {
    $priorConsole = [Console]::OutputEncoding
    $priorOutput = $OutputEncoding
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Console]::OutputEncoding
    try {
      & npx playwright test test_playwright_version/tc_ext_017_ui_reconnect_isolated.spec.ts `
        --project=chromium 2>&1 | Tee-Object -FilePath $evidenceLog -Append
      $exitCode = $LASTEXITCODE
    } finally {
      [Console]::OutputEncoding = $priorConsole
      $OutputEncoding = $priorOutput
    }
  } finally { Pop-Location }

  $after = [string](Invoke-RestMethod -Method Get -Uri "$base/version" -TimeoutSec 20).commit
  if ($after -ne $before) {
    '[TC_EXT_017] INCONCLUSIVE: staging build changed during the run' |
      Tee-Object -FilePath $evidenceLog -Append
    $exitCode = 1
  }
} finally {
  Remove-Item Env:BASE_URL, Env:TC_EXT_017_STAGING_PIN, Env:TC_EXT_017_EXPECT_UI_WS `
    -ErrorAction SilentlyContinue
  $pin = $null
  $credential = $null
}

Write-Host "TC_EXT_017 UI Terminal evidence: $evidenceLog"
Write-Host '[TC_EXT_017] A skipped readiness gate is Pending, not a business PASS. Check CLEANUP REQUIRED on failure.'
exit $exitCode
