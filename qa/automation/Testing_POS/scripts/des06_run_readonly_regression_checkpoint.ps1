param([string]$BaseUrl = 'http://160.191.47.17')

$ErrorActionPreference = 'Stop'
$base = $BaseUrl.TrimEnd('/')
if ($base -ne 'http://160.191.47.17') { throw 'DES-QA-06 regression is restricted to approved staging' }

$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\DES-QA-06'
$evidenceLog = Join-Path $evidenceDir ("REGRESSION_READONLY_{0}.log" -f (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
$exitCode = 1
$credential = $null
$seedPassword = $null
$versionBefore = $null

try {
  $credential = Get-Credential -UserName 'cashier' -Message 'Shared staging PIN for Cashier, Kitchen and admin read-only regression'
  if (-not $credential) { throw 'Credential prompt cancelled' }
  $seedPassword = $credential.GetNetworkCredential().Password
  if (-not $seedPassword) { throw 'Staging PIN is empty' }

  New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
  $versionBefore = (Invoke-RestMethod -Method Get -Uri "$base/version" -TimeoutSec 20).commit
  if ($versionBefore -notmatch '^[0-9a-f]{40}$') { throw 'GET /version did not return a full commit SHA' }
  "[DES-QA-06] Read-only regression start: staging $($versionBefore.Substring(0, 12))" |
    Tee-Object -FilePath $evidenceLog

  $env:CYPRESS_POS_BASE_URL = $base
  foreach ($account in @('CASHIER', 'KITCHEN', 'ADMIN')) {
    Set-Item -Path "Env:CYPRESS_DES06_${account}_USERNAME" -Value $account.ToLowerInvariant()
    Set-Item -Path "Env:CYPRESS_DES06_${account}_PASSWORD" -Value $seedPassword
  }

  Push-Location (Split-Path -Parent $PSScriptRoot)
  try {
    $priorConsoleEncoding = [Console]::OutputEncoding
    $priorOutputEncoding = $OutputEncoding
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Console]::OutputEncoding
    try {
      $specs = @(
        'cypress/e2e/des_qa_06/des_qa_06_readonly_preflight.cy.js',
        'cypress/e2e/des_qa_06/des_qa_06_readonly_business.cy.js',
        'cypress/e2e/des_qa_06/des_qa_06_sla_live_queue_observation.cy.js'
      ) -join ','
      & npx cypress run --browser chrome --headless --spec $specs 2>&1 |
        Tee-Object -FilePath $evidenceLog -Append
      $exitCode = $LASTEXITCODE
    } finally {
      [Console]::OutputEncoding = $priorConsoleEncoding
      $OutputEncoding = $priorOutputEncoding
    }
  } finally { Pop-Location }

  $versionAfter = (Invoke-RestMethod -Method Get -Uri "$base/version" -TimeoutSec 20).commit
  if ($versionAfter -ne $versionBefore) {
    "[DES-QA-06] INCONCLUSIVE: staging changed during run $($versionBefore.Substring(0, 12)) -> $($versionAfter.Substring(0, 12))" |
      Tee-Object -FilePath $evidenceLog -Append
    $exitCode = 1
  } else {
    "[DES-QA-06] Read-only regression finish: staging $($versionAfter.Substring(0, 12)); Cypress exit $exitCode" |
      Tee-Object -FilePath $evidenceLog -Append
  }
} finally {
  'CYPRESS_POS_BASE_URL', 'CYPRESS_DES06_CASHIER_USERNAME', 'CYPRESS_DES06_CASHIER_PASSWORD',
  'CYPRESS_DES06_KITCHEN_USERNAME', 'CYPRESS_DES06_KITCHEN_PASSWORD',
  'CYPRESS_DES06_ADMIN_USERNAME', 'CYPRESS_DES06_ADMIN_PASSWORD' |
    ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }
  $seedPassword = $null
  $credential = $null
}

Write-Host "DES-QA-06 Terminal evidence: $evidenceLog"
Write-Host '[DES-QA-06] Preflight checks are not business testcase passes.'
exit $exitCode
