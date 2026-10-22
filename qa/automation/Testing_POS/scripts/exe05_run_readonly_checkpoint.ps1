param(
  [string]$BaseUrl = 'http://160.191.47.17',
  [string]$ExpectedCommit = ''
)

# EXE-QA-05 checkpoint only: business GET, auth login and WebSocket ping.
# The runner results must not be counted as new business testcase passes.
$ErrorActionPreference = 'Stop'
$base = $BaseUrl.TrimEnd('/')
if ($base -ne 'http://160.191.47.17') { throw 'EXE-QA-05 is restricted to approved staging' }
if ($ExpectedCommit -and $ExpectedCommit -notmatch '^[0-9a-fA-F]{7,40}$') {
  throw 'ExpectedCommit must be a 7-40 character Git commit prefix'
}

$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\EXE-QA-05'
$evidenceLog = Join-Path $evidenceDir ("READONLY_CHECKPOINT_{0}.log" -f (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
$credential = $null
$pin = $null
$cypressExit = 1
$playwrightExit = 1
$versionAfter = $null

try {
  $versionBefore = [string](Invoke-RestMethod -Uri "$base/version" -Method Get -TimeoutSec 20).commit
  if ($versionBefore -notmatch '^[0-9a-f]{40}$') { throw 'GET /version did not return a full commit SHA' }
  if ($ExpectedCommit -and -not $versionBefore.StartsWith($ExpectedCommit, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Staging commit $versionBefore differs from expected $ExpectedCommit"
  }

  $credential = Get-Credential -UserName 'kitchen' -Message 'Shared QA staging PIN for read-only Kitchen, Cashier and Supervisor checks'
  if (-not $credential) { throw 'Credential prompt cancelled' }
  $pin = $credential.GetNetworkCredential().Password
  if (-not $pin) { throw 'Staging PIN is empty' }

  New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
  "[EXE-QA-05] Checkpoint staging $versionBefore; login POST, business GET, WS ping; no business mutation" |
    Tee-Object -FilePath $evidenceLog

  $env:CYPRESS_POS_BASE_URL = $base
  $env:CYPRESS_EXE04_EXPECTED_COMMIT = $versionBefore
  $env:CYPRESS_EXE04_SEED_PASSWORD = $pin
  foreach ($account in @('CASHIER', 'KITCHEN', 'ADMIN')) {
    Set-Item -Path "Env:CYPRESS_DES06_${account}_USERNAME" -Value $account.ToLowerInvariant()
    Set-Item -Path "Env:CYPRESS_DES06_${account}_PASSWORD" -Value $pin
  }
  $env:BASE_URL = $base

  Push-Location (Split-Path -Parent $PSScriptRoot)
  try {
    $priorConsoleEncoding = [Console]::OutputEncoding
    $priorOutputEncoding = $OutputEncoding
    $priorErrorActionPreference = $ErrorActionPreference
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Console]::OutputEncoding
    try {
      # Windows PowerShell may wrap harmless npm stderr as ErrorRecords.
      $ErrorActionPreference = 'Continue'
      $specs = @(
        'cypress/e2e/exe_qa_04/exe_qa_04_readonly_smoke.cy.js',
        'cypress/e2e/des_qa_06/des_qa_06_readonly_preflight.cy.js',
        'cypress/e2e/des_qa_06/des_qa_06_readonly_business.cy.js',
        'cypress/e2e/des_qa_06/des_qa_06_sla_live_queue_observation.cy.js'
      ) -join ','
      & npx cypress run --browser chrome --headless --spec $specs 2>&1 |
        Tee-Object -FilePath $evidenceLog -Append
      $cypressExit = $LASTEXITCODE
      "[EXE-QA-05] Cypress exit $cypressExit" | Tee-Object -FilePath $evidenceLog -Append

      & npx playwright test pos-smoke.spec.ts --project=chromium 2>&1 |
        Tee-Object -FilePath $evidenceLog -Append
      $playwrightExit = $LASTEXITCODE
      "[EXE-QA-05] Anonymous route guard exit $playwrightExit" |
        Tee-Object -FilePath $evidenceLog -Append
    } finally {
      $ErrorActionPreference = $priorErrorActionPreference
      [Console]::OutputEncoding = $priorConsoleEncoding
      $OutputEncoding = $priorOutputEncoding
    }
  } finally { Pop-Location }

  $versionAfter = [string](Invoke-RestMethod -Uri "$base/version" -Method Get -TimeoutSec 20).commit
  if ($versionAfter -ne $versionBefore) {
    "[EXE-QA-05] INCONCLUSIVE: staging changed $versionBefore -> $versionAfter" |
      Tee-Object -FilePath $evidenceLog -Append
  } else {
    "[EXE-QA-05] Same staging commit $versionAfter; Cypress exit $cypressExit; Playwright exit $playwrightExit" |
      Tee-Object -FilePath $evidenceLog -Append
  }
} finally {
  'CYPRESS_POS_BASE_URL', 'CYPRESS_EXE04_EXPECTED_COMMIT', 'CYPRESS_EXE04_SEED_PASSWORD',
  'CYPRESS_DES06_CASHIER_USERNAME', 'CYPRESS_DES06_CASHIER_PASSWORD',
  'CYPRESS_DES06_KITCHEN_USERNAME', 'CYPRESS_DES06_KITCHEN_PASSWORD',
  'CYPRESS_DES06_ADMIN_USERNAME', 'CYPRESS_DES06_ADMIN_PASSWORD', 'BASE_URL' |
    ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }
  $pin = $null
  $credential = $null
}

Write-Host "EXE-QA-05 Terminal evidence: $evidenceLog"
Write-Host '[EXE-QA-05] Read-only checkpoint; business bug retests and M2 signoff remain separate.'
if ($versionAfter -ne $versionBefore -or $cypressExit -ne 0 -or $playwrightExit -ne 0) { exit 1 }
exit 0
