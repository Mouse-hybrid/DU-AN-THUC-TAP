param(
  [string]$BaseUrl = 'http://160.191.47.17',
  [switch]$Tc007Only,
  [string]$ExpectedCommit = 'd466a3d'
)

$ErrorActionPreference = 'Stop'
if ($Tc007Only) {
  $version = Invoke-RestMethod -Uri ($BaseUrl.TrimEnd('/') + '/version') -TimeoutSec 10
  $stagingCommit = [string]$version.commit
  if (-not $stagingCommit) { $stagingCommit = [string]$version.short_commit }
  Write-Host "[DES-QA-05] Staging commit: $stagingCommit"
  if (-not $stagingCommit.StartsWith($ExpectedCommit, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Staging commit differs from expected $ExpectedCommit. Confirm PR #29 is deployed before TC-007 retest."
  }
}
$credential = Get-Credential -UserName 'waiter' -Message 'Shared staging password for waiter/kitchen/cashier (used only for this run)'
$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\DES-QA-05'
New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
$evidencePrefix = if ($Tc007Only) { 'TC-007_RETEST' } else { 'TC-001_to_007' }
$evidenceLog = Join-Path $evidenceDir ("{0}_{1}.log" -f $evidencePrefix, (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
$exitCode = 1

try {
  $env:CYPRESS_POS_BASE_URL = $BaseUrl
  $env:CYPRESS_DES05_SEED_PASSWORD = $credential.GetNetworkCredential().Password
  if ($Tc007Only) { $env:CYPRESS_DES05_TC007_ONLY = 'true' }
  Push-Location (Split-Path -Parent $PSScriptRoot)
  try {
    $previousConsole = [Console]::OutputEncoding
    $previousOutput = $OutputEncoding
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Console]::OutputEncoding
    try {
      & npx cypress run --browser chrome --headless --spec 'cypress/e2e/des_qa_05/des_qa_05_routing_isolated.cy.js' 2>&1 |
        Tee-Object -FilePath $evidenceLog
      $exitCode = $LASTEXITCODE
    } finally {
      [Console]::OutputEncoding = $previousConsole
      $OutputEncoding = $previousOutput
    }
  } finally { Pop-Location }
} finally {
  Remove-Item Env:CYPRESS_POS_BASE_URL, Env:CYPRESS_DES05_SEED_PASSWORD, Env:CYPRESS_DES05_TC007_ONLY -ErrorAction SilentlyContinue
  $credential = $null
}

Write-Host "DES-QA-05 Terminal evidence: $evidenceLog"
if ($exitCode -ne 0) {
  Write-Warning 'Check CLEANUP REQUIRED in the log. Staging is not reset automatically.'
}
exit $exitCode
