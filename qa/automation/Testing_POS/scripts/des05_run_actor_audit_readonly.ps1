param(
  [string]$BaseUrl = 'http://160.191.47.17',
  [string]$ExpectedCommit = 'd466a3d'
)

$ErrorActionPreference = 'Stop'
$credential = Get-Credential -UserName 'admin' -Message 'Staging Supervisor/admin credential for read-only audit evidence'
$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\DES-QA-05'
New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
$evidenceLog = Join-Path $evidenceDir ("AUDIT_TC-012_019_{0}.log" -f (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
$exitCode = 1

try {
  $env:CYPRESS_POS_BASE_URL = $BaseUrl
  $env:CYPRESS_DES05_EXPECTED_COMMIT = $ExpectedCommit
  $env:CYPRESS_DES05_AUDIT_PASSWORD = $credential.GetNetworkCredential().Password
  Push-Location (Split-Path -Parent $PSScriptRoot)
  try {
    $previousConsole = [Console]::OutputEncoding
    $previousOutput = $OutputEncoding
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Console]::OutputEncoding
    try {
      & npx cypress run --browser chrome --headless --spec 'cypress/e2e/des_qa_05/des_qa_05_actor_audit_readonly.cy.js' 2>&1 |
        Tee-Object -FilePath $evidenceLog
      $exitCode = $LASTEXITCODE
    } finally {
      [Console]::OutputEncoding = $previousConsole
      $OutputEncoding = $previousOutput
    }
  } finally { Pop-Location }
} finally {
  Remove-Item Env:CYPRESS_POS_BASE_URL, Env:CYPRESS_DES05_EXPECTED_COMMIT, Env:CYPRESS_DES05_AUDIT_PASSWORD -ErrorAction SilentlyContinue
  $credential = $null
}

Write-Host "DES-QA-05 Actor audit evidence: $evidenceLog"
exit $exitCode
