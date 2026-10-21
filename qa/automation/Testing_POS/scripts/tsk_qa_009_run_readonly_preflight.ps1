param(
  [string]$BaseUrl = 'http://160.191.47.17',
  [string]$ExpectedCommit = ''
)

$ErrorActionPreference = 'Stop'
$base = $BaseUrl.TrimEnd('/')
if ($base -ne 'http://160.191.47.17') { throw 'TSK-QA-009 preflight is restricted to approved staging' }

$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\DES-QA-05'
$evidenceLog = Join-Path $evidenceDir ("TSK_QA_009_READONLY_{0}.log" -f (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
function Record([string]$line) { $line | Tee-Object -FilePath $evidenceLog -Append }

$credential = $null
$exitCode = 1
try {
  $before = [string](Invoke-RestMethod -Uri "$base/version" -TimeoutSec 20).commit
  if ($before -notmatch '^[0-9a-f]{40}$') { throw 'GET /version did not return a full commit' }
  if ($ExpectedCommit -and -not $before.StartsWith($ExpectedCommit, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Staging commit $before differs from expected $ExpectedCommit"
  }
  Record "[TSK-QA-009] Read-only preflight staging $before; station/menu and live Modifier contract"

  $credential = Get-Credential -UserName 'waiter' -Message 'Shared staging password for waiter/kitchen read-only inventory'
  if (-not $credential) { throw 'Credential prompt cancelled' }
  $password = $credential.GetNetworkCredential().Password
  if (-not $password) { throw 'Password is empty' }
  $env:CYPRESS_POS_BASE_URL = $base
  $env:CYPRESS_DES05_SEED_PASSWORD = $password
  $password = $null

  Push-Location (Split-Path -Parent $PSScriptRoot)
  try {
    $previousConsole = [Console]::OutputEncoding
    $previousOutput = $OutputEncoding
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Console]::OutputEncoding
    try {
      $specs = @(
        'cypress/e2e/des_qa_05/env_qa_03_station_menu_inventory.cy.js'
        'cypress/e2e/des_qa_05/des_qa_05_tc_011_modifier_contract_preflight.cy.js'
      ) -join ','
      & npx cypress run --browser chrome --headless --spec $specs 2>&1 |
        Tee-Object -FilePath $evidenceLog -Append
      $exitCode = $LASTEXITCODE
    } finally {
      [Console]::OutputEncoding = $previousConsole
      $OutputEncoding = $previousOutput
    }
  } finally { Pop-Location }

  $after = [string](Invoke-RestMethod -Uri "$base/version" -TimeoutSec 20).commit
  if ($after -ne $before) { throw 'Staging changed during the preflight; discard this evidence' }
  $evidence = Get-Content -Path $evidenceLog -Raw
  if ($exitCode -ne 0) {
    Record "[TSK-QA-009] ERROR: Cypress exit $exitCode; inspect failed assertions"
  } elseif ($evidence -match 'ENV-QA-03 PENDING|PF-05 PENDING') {
    Record '[TSK-QA-009] BLOCKED: fixture and/or Modifier contract not ready; six-station business routing untested'
  } else {
    Record '[TSK-QA-009] PREFLIGHT READY: inspect the two checks; six-station and Modifier business routing untested'
  }
} finally {
  Remove-Item Env:CYPRESS_POS_BASE_URL, Env:CYPRESS_DES05_SEED_PASSWORD -ErrorAction SilentlyContinue
  $password = $null
  $credential = $null
  Write-Host "TSK-QA-009 Terminal evidence: $evidenceLog"
  Write-Host '[TSK-QA-009] Preflight results are not business testcase passes; no order/menu mutation or staging reset.'
}
exit $exitCode
