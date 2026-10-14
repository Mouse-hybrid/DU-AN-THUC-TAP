param([string]$BaseUrl = 'http://160.191.47.17')

$ErrorActionPreference = 'Stop'
$exitCode = 1
$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\DES-QA-06'
$evidenceLog = Join-Path $evidenceDir ("TC-027_to_031_{0}.log" -f (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
$credential = $null

try {
  $credential = Get-Credential -UserName 'admin' -Message 'Supervisor staging PIN for isolated QA menu items'
  if (-not $credential) { throw 'Credential prompt cancelled' }
  $password = $credential.GetNetworkCredential().Password
  if (-not $password) { throw 'Staging PIN is empty' }

  $env:CYPRESS_POS_BASE_URL = $BaseUrl.TrimEnd('/')
  $env:CYPRESS_DES06_ADMIN_USERNAME = 'admin'
  $env:CYPRESS_DES06_ADMIN_PASSWORD = $password
  $password = $null
  New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
  Push-Location (Split-Path -Parent $PSScriptRoot)
  try {
    $previousConsole = [Console]::OutputEncoding
    $previousOutput = $OutputEncoding
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Console]::OutputEncoding
    try {
      & npx cypress run --browser chrome --headless --spec 'cypress/e2e/des_qa_06/des_qa_06_item_update_query_isolated.cy.js' 2>&1 |
        Tee-Object -FilePath $evidenceLog
      $exitCode = $LASTEXITCODE
    } finally {
      [Console]::OutputEncoding = $previousConsole
      $OutputEncoding = $previousOutput
    }
  } finally { Pop-Location }
} finally {
  Remove-Item Env:CYPRESS_POS_BASE_URL, Env:CYPRESS_DES06_ADMIN_USERNAME, Env:CYPRESS_DES06_ADMIN_PASSWORD -ErrorAction SilentlyContinue
  $credential = $null
}

Write-Host "DES-QA-06 Terminal evidence: $evidenceLog"
if ($exitCode -ne 0) {
  Write-Warning 'Check CLEANUP REQUIRED in the log. Inactive QA items remain in staging.'
}
exit $exitCode
