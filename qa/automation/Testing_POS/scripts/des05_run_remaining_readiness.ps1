param(
  [string]$BaseUrl = 'http://160.191.47.17'
)

$ErrorActionPreference = 'Stop'
$credential = Get-Credential -UserName 'kitchen' -Message 'Shared staging password for Kitchen (this run only)'
$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\DES-QA-05'
New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
$evidenceLog = Join-Path $evidenceDir ("READINESS_REMAINING_{0}.log" -f (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
$exitCode = 1

try {
  $version = Invoke-RestMethod -Uri ($BaseUrl.TrimEnd('/') + '/version') -TimeoutSec 10
  $stagingCommit = [string]$version.commit
  if (-not $stagingCommit) { $stagingCommit = [string]$version.short_commit }
  "[DES-QA-05] Readiness audit staging commit $stagingCommit" | Tee-Object -FilePath $evidenceLog
  '[DES-QA-05] Scope: six stations, modifier contract, Expeditor action; no business testcase executed.' |
    Tee-Object -FilePath $evidenceLog -Append

  $env:CYPRESS_POS_BASE_URL = $BaseUrl
  $env:CYPRESS_EXT_KITCHEN_USERNAME = 'kitchen'
  $env:CYPRESS_EXT_KITCHEN_PASSWORD = $credential.GetNetworkCredential().Password

  Push-Location (Split-Path -Parent $PSScriptRoot)
  try {
    $priorConsoleEncoding = [Console]::OutputEncoding
    $priorOutputEncoding = $OutputEncoding
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Console]::OutputEncoding
    try {
      $specs = @(
        'cypress/e2e/des_qa_05/des_qa_05_tc_011_modifier_contract_preflight.cy.js'
        'cypress/e2e/des_qa_05/des_qa_05_tc_018_expeditor_rbac_contract_preflight.cy.js'
        'cypress/e2e/des_qa_05/des_qa_05_tc_025_e2e_readiness_preflight.cy.js'
      ) -join ','
      & npx cypress run --browser chrome --headless --spec $specs 2>&1 |
        Tee-Object -FilePath $evidenceLog -Append
      $exitCode = $LASTEXITCODE
    } finally {
      [Console]::OutputEncoding = $priorConsoleEncoding
      $OutputEncoding = $priorOutputEncoding
    }
  } finally { Pop-Location }
} finally {
  'CYPRESS_POS_BASE_URL', 'CYPRESS_EXT_KITCHEN_USERNAME', 'CYPRESS_EXT_KITCHEN_PASSWORD' |
    ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }
  $credential = $null
}

Write-Host "DES-QA-05 Readiness evidence: $evidenceLog"
exit $exitCode
