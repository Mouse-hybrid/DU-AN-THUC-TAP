param(
  [string]$BaseUrl = 'http://160.191.47.17',
  [string]$OrderId = 'acf6fbe4-4805-47d9-9637-3bad0335fc27',
  [string]$ItemId = '635c76e5-0a22-48ac-88a1-661f70defbce'
)

$ErrorActionPreference = 'Stop'
$base = $BaseUrl.TrimEnd('/')
if ($base -ne 'http://160.191.47.17') { throw 'TC_API_20_002 is restricted to approved staging' }
if ($OrderId -notmatch '^[0-9a-fA-F-]{36}$' -or $ItemId -notmatch '^[0-9a-fA-F-]{36}$') {
  throw 'Historical order and item IDs must be UUIDs'
}
$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\AFG_POS'
$evidenceLog = Join-Path $evidenceDir ("TC_API_20_002_VOID_QUEUE_{0}.log" -f (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
$credential = $null
$seedPassword = $null
$exitCode = 1

try {
  $credential = Get-Credential -UserName 'kitchen' -Message 'Shared staging PIN for read-only Kitchen Queue inspection'
  if (-not $credential) { throw 'Credential prompt cancelled' }
  $seedPassword = $credential.GetNetworkCredential().Password
  if (-not $seedPassword) { throw 'Staging PIN is empty' }
  New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
  $before = (Invoke-RestMethod -Method Get -Uri "$base/version" -TimeoutSec 20).commit
  if ($before -notmatch '^[0-9a-f]{40}$') { throw 'GET /version missing full commit' }
  "[Phase 1] TC_API_20_002 staging start $($before.Substring(0, 12)); read-only historical QA fixture" |
    Tee-Object -FilePath $evidenceLog

  $env:CYPRESS_POS_BASE_URL = $base
  $env:CYPRESS_DES05_SEED_PASSWORD = $seedPassword
  $env:CYPRESS_PHASE1_VOID_ORDER_ID = $OrderId
  $env:CYPRESS_PHASE1_VOID_ITEM_ID = $ItemId
  Push-Location (Split-Path -Parent $PSScriptRoot)
  try {
    $priorConsole = [Console]::OutputEncoding
    $priorOutput = $OutputEncoding
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Console]::OutputEncoding
    try {
      & npx cypress run --browser chrome --headless --spec 'cypress/e2e/tc_ext/tc_api_20_002_void_queue_readonly.cy.js' 2>&1 |
        Tee-Object -FilePath $evidenceLog -Append
      $exitCode = $LASTEXITCODE
    } finally {
      [Console]::OutputEncoding = $priorConsole
      $OutputEncoding = $priorOutput
    }
  } finally { Pop-Location }

  $after = (Invoke-RestMethod -Method Get -Uri "$base/version" -TimeoutSec 20).commit
  if ($after -ne $before) {
    '[Phase 1] TC_API_20_002 INCONCLUSIVE: staging changed during run' |
      Tee-Object -FilePath $evidenceLog -Append
    $exitCode = 1
  }
} finally {
  Remove-Item Env:CYPRESS_POS_BASE_URL, Env:CYPRESS_DES05_SEED_PASSWORD, Env:CYPRESS_PHASE1_VOID_ORDER_ID, Env:CYPRESS_PHASE1_VOID_ITEM_ID -ErrorAction SilentlyContinue
  $seedPassword = $null
  $credential = $null
}

Write-Host "Phase 1 Terminal evidence: $evidenceLog"
Write-Host '[Phase 1] Read-only check; no staging order or kitchen ticket created.'
exit $exitCode
