param(
  [string]$BaseUrl = 'http://160.191.47.17',
  [switch]$Tc025Only
)

$ErrorActionPreference = 'Stop'
$credential = Get-Credential -UserName 'waiter' -Message 'Shared staging password for waiter/kitchen/cashier (this run only)'
$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\DES-QA-05'
New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
$evidencePrefix = if ($Tc025Only) { 'API_COMP_TC-025' } else { 'API_COMP_TC-016_017_025' }
$evidenceLog = Join-Path $evidenceDir ("{0}_{1}.log" -f $evidencePrefix, (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
$exitCode = 1

try {
  $version = Invoke-RestMethod -Uri ($BaseUrl.TrimEnd('/') + '/version') -TimeoutSec 10
  $commit = [string]$version.commit
  if (-not $commit) { $commit = [string]$version.short_commit }
  "[DES-QA-05] API component staging commit $commit; two-station fixture; Expeditor UI/modifiers/six-station E2E not tested" |
    Tee-Object -FilePath $evidenceLog
  $env:CYPRESS_POS_BASE_URL = $BaseUrl
  $env:CYPRESS_DES05_SEED_PASSWORD = $credential.GetNetworkCredential().Password
  if ($Tc025Only) { $env:CYPRESS_DES05_TC025_ONLY = 'true' }
  Push-Location (Split-Path -Parent $PSScriptRoot)
  try {
    $previousConsole = [Console]::OutputEncoding
    $previousOutput = $OutputEncoding
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Console]::OutputEncoding
    try {
      & npx cypress run --browser chrome --headless --spec 'cypress/e2e/des_qa_05/des_qa_05_expeditor_api_component_isolated.cy.js' 2>&1 |
        Tee-Object -FilePath $evidenceLog -Append
      $exitCode = $LASTEXITCODE
    } finally {
      [Console]::OutputEncoding = $previousConsole
      $OutputEncoding = $previousOutput
    }
  } finally { Pop-Location }
} finally {
  Remove-Item Env:CYPRESS_POS_BASE_URL, Env:CYPRESS_DES05_SEED_PASSWORD, Env:CYPRESS_DES05_TC025_ONLY -ErrorAction SilentlyContinue
  $credential = $null
}

Write-Host "DES-QA-05 API component evidence: $evidenceLog"
if ($exitCode -ne 0) { Write-Warning 'Check CLEANUP REQUIRED in the log. Staging is not reset automatically.' }
exit $exitCode
