param(
  [string]$BaseUrl = 'http://160.191.47.17',
  [string]$OrderId = ''
)

$ErrorActionPreference = 'Stop'
$seedCredential = Get-Credential -UserName 'cashier' -Message 'Mật khẩu chung của cashier/kitchen trên STAGING do BE cấp'
$exitCode = 1
$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\DES-QA-05'
$evidenceLog = Join-Path $evidenceDir ("PF-02_03_12_{0}.log" -f (Get-Date -Format 'yyyy-MM-dd_HHmmss'))

function Get-SeedLoginStatus {
  param([string]$Username, [string]$Password)
  $body = @{ username = $Username; password = $Password } | ConvertTo-Json -Compress
  try {
    $response = Invoke-WebRequest -Uri "$($BaseUrl.TrimEnd('/'))/api/v1/auth/login" `
      -Method Post -ContentType 'application/json' -Body $body -UseBasicParsing -TimeoutSec 20
    return [string][int]$response.StatusCode
  } catch {
    if ($_.Exception.Response) { return [string][int]$_.Exception.Response.StatusCode }
    return 'NETWORK_ERROR'
  } finally {
    $body = $null
  }
}

try {
  # This run uses the seeded accounts, even if this shell had stale JWT variables.
  'CYPRESS_DES05_MENU_TOKEN', 'CYPRESS_EXT_KITCHEN_TOKEN', 'CYPRESS_EXT_REFIRE_SUPERVISOR_TOKEN',
  'CYPRESS_EXT_REFIRE_ORDER_ID', 'CYPRESS_EXT_REFIRE_SUPERVISOR_USERNAME',
  'CYPRESS_EXT_REFIRE_SUPERVISOR_PASSWORD' |
    ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }

  $seedPassword = $seedCredential.GetNetworkCredential().Password
  $cashierStatus = Get-SeedLoginStatus -Username 'cashier' -Password $seedPassword
  $kitchenStatus = Get-SeedLoginStatus -Username 'kitchen' -Password $seedPassword
  New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null

  if ($cashierStatus -ne '200' -or $kitchenStatus -ne '200') {
    $report = @(
      "[DES-QA-05] Login cashier HTTP $cashierStatus; kitchen HTTP $kitchenStatus"
      '[DES-QA-05] Auth precheck failed; Cypress and business GET requests were not run.'
      '[DES-QA-05] No password, token or response body was logged.'
    )
    $report | Set-Content -Path $evidenceLog -Encoding UTF8
    $report | ForEach-Object { Write-Host $_ }
    $exitCode = 2
  } else {
    $env:CYPRESS_POS_BASE_URL = $BaseUrl
    $env:CYPRESS_POS_USERNAME = 'cashier'
    $env:CYPRESS_POS_PASSWORD = $seedPassword
    $env:CYPRESS_EXT_KITCHEN_USERNAME = 'kitchen'
    $env:CYPRESS_EXT_KITCHEN_PASSWORD = $seedPassword

    if ($OrderId) {
      $env:CYPRESS_EXT_REFIRE_ORDER_ID = $OrderId
      $adminStatus = Get-SeedLoginStatus -Username 'admin' -Password $seedPassword
      $adminReport = "[DES-QA-05] Login username=admin (SUPERVISOR) HTTP $adminStatus"
      $adminReport | Add-Content -Path $evidenceLog -Encoding UTF8
      Write-Host $adminReport
      if ($adminStatus -eq '200') {
        $env:CYPRESS_EXT_REFIRE_SUPERVISOR_USERNAME = 'admin'
        $env:CYPRESS_EXT_REFIRE_SUPERVISOR_PASSWORD = $seedPassword
      } else {
        Write-Host '[DES-QA-05] PF-04 will remain Pending: admin login unavailable.'
      }
    }

    Push-Location (Split-Path -Parent $PSScriptRoot)
    try {
      # Cypress uses UTF-8 box characters; decode native output as UTF-8 before Tee-Object.
      $priorConsoleEncoding = [Console]::OutputEncoding
      $priorOutputEncoding = $OutputEncoding
      [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
      $OutputEncoding = [Console]::OutputEncoding
      & npx cypress run --browser chrome --headless --spec 'cypress/e2e/des_qa_05/des_qa_05_kds_refire_readonly_preflight.cy.js,cypress/e2e/des_qa_05/des_qa_05_orders_list_readonly_preflight.cy.js' 2>&1 |
        Tee-Object -FilePath $evidenceLog -Append
      $exitCode = $LASTEXITCODE
    } finally {
      [Console]::OutputEncoding = $priorConsoleEncoding
      $OutputEncoding = $priorOutputEncoding
      Pop-Location
    }
  }
} finally {
  'CYPRESS_POS_BASE_URL', 'CYPRESS_POS_USERNAME', 'CYPRESS_POS_PASSWORD',
  'CYPRESS_EXT_KITCHEN_USERNAME', 'CYPRESS_EXT_KITCHEN_PASSWORD',
  'CYPRESS_EXT_REFIRE_ORDER_ID', 'CYPRESS_EXT_REFIRE_SUPERVISOR_USERNAME',
  'CYPRESS_EXT_REFIRE_SUPERVISOR_PASSWORD', 'CYPRESS_DES05_MENU_TOKEN',
  'CYPRESS_EXT_KITCHEN_TOKEN', 'CYPRESS_EXT_REFIRE_SUPERVISOR_TOKEN' |
    ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }
  $seedPassword = $null
  $seedCredential = $null
}

Write-Host "DES-QA-05 Terminal evidence: $evidenceLog"
exit $exitCode
