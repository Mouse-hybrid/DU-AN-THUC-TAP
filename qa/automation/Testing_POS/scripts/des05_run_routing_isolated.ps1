param([string]$BaseUrl = 'http://160.191.47.17')

$ErrorActionPreference = 'Stop'
$credential = Get-Credential -UserName 'waiter' -Message 'Mật khẩu staging dùng chung của waiter/kitchen/cashier (chỉ lưu trong phiên chạy)'
$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\DES-QA-05'
New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
$evidenceLog = Join-Path $evidenceDir ("TC-001_003_004_{0}.log" -f (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
$exitCode = 1

try {
  $env:CYPRESS_POS_BASE_URL = $BaseUrl
  $env:CYPRESS_DES05_SEED_PASSWORD = $credential.GetNetworkCredential().Password
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
  Remove-Item Env:CYPRESS_POS_BASE_URL, Env:CYPRESS_DES05_SEED_PASSWORD -ErrorAction SilentlyContinue
  $credential = $null
}

Write-Host "DES-QA-05 Terminal evidence: $evidenceLog"
if ($exitCode -ne 0) {
  Write-Warning 'Kiểm tra CLEANUP REQUIRED trong log. Không reset staging tự động.'
}
exit $exitCode
