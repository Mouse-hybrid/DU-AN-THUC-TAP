param([string]$BaseUrl = 'http://160.191.47.17')

$ErrorActionPreference = 'Stop'
$exitCode = 1
$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\DES-QA-06'
$evidenceLog = Join-Path $evidenceDir ("CONTRACT_034_035_036_{0}.log" -f (Get-Date -Format 'yyyy-MM-dd_HHmmss'))

try {
  $env:CYPRESS_POS_BASE_URL = $BaseUrl.TrimEnd('/')
  New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
  Push-Location (Split-Path -Parent $PSScriptRoot)
  try {
    $previousConsole = [Console]::OutputEncoding
    $previousOutput = $OutputEncoding
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Console]::OutputEncoding
    try {
      & npx cypress run --browser chrome --headless --spec 'cypress/e2e/des_qa_06/des_qa_06_menu_contract_readiness.cy.js' 2>&1 |
        Tee-Object -FilePath $evidenceLog
      $exitCode = $LASTEXITCODE
    } finally {
      [Console]::OutputEncoding = $previousConsole
      $OutputEncoding = $previousOutput
    }
  } finally { Pop-Location }
} finally {
  Remove-Item Env:CYPRESS_POS_BASE_URL -ErrorAction SilentlyContinue
}

Write-Host "DES-QA-06 Terminal evidence: $evidenceLog"
exit $exitCode
