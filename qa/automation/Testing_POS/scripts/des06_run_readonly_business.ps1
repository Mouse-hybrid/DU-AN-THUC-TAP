param(
  [string]$BaseUrl = 'http://160.191.47.17'
)

$ErrorActionPreference = 'Stop'
$exitCode = 1
$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\DES-QA-06'
$evidenceLog = Join-Path $evidenceDir ("TC-017_PF-07_08_{0}.log" -f (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
$credential = $null
$seedPassword = $null

try {
  $credential = Get-Credential -UserName 'cashier' -Message 'Shared staging PIN for cashier, kitchen and admin'
  if (-not $credential) { throw 'Credential prompt cancelled' }
  $seedPassword = $credential.GetNetworkCredential().Password
  if (-not $seedPassword) { throw 'Staging PIN is empty' }

  $env:CYPRESS_POS_BASE_URL = $BaseUrl.TrimEnd('/')
  foreach ($account in @('CASHIER', 'KITCHEN', 'ADMIN')) {
    $envName = 'CYPRESS_DES06_{0}_USERNAME' -f $account
    $envPassword = 'CYPRESS_DES06_{0}_PASSWORD' -f $account
    Set-Item -Path "Env:$envName" -Value $account.ToLowerInvariant()
    Set-Item -Path "Env:$envPassword" -Value $seedPassword
  }

  New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
  Push-Location (Split-Path -Parent $PSScriptRoot)
  try {
    $priorConsoleEncoding = [Console]::OutputEncoding
    $priorOutputEncoding = $OutputEncoding
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Console]::OutputEncoding
    try {
      & npx cypress run --browser chrome --headless --spec 'cypress/e2e/des_qa_06/des_qa_06_readonly_business.cy.js' 2>&1 |
        Tee-Object -FilePath $evidenceLog -Append
      $exitCode = $LASTEXITCODE
    } finally {
      [Console]::OutputEncoding = $priorConsoleEncoding
      $OutputEncoding = $priorOutputEncoding
    }
  } finally {
    Pop-Location
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
exit $exitCode
