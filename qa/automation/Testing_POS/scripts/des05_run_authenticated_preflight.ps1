param(
  [string]$BaseUrl = 'http://160.191.47.17',
  [string]$OrderId = ''
)

$ErrorActionPreference = 'Stop'
$adminCredential = Get-Credential -UserName 'admin' -Message 'Staging admin (SUPERVISOR) cho PF-02/PF-12'
$kitchenCredential = Get-Credential -UserName 'kitchen' -Message 'Staging kitchen cho PF-03'
$exitCode = 1

try {
  # This run uses the seeded accounts, even if this shell had stale JWT variables.
  'CYPRESS_DES05_MENU_TOKEN', 'CYPRESS_EXT_KITCHEN_TOKEN', 'CYPRESS_EXT_REFIRE_SUPERVISOR_TOKEN' |
    ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }

  $env:CYPRESS_POS_BASE_URL = $BaseUrl
  $env:CYPRESS_POS_USERNAME = $adminCredential.UserName
  $env:CYPRESS_POS_PASSWORD = $adminCredential.GetNetworkCredential().Password
  $env:CYPRESS_EXT_KITCHEN_USERNAME = $kitchenCredential.UserName
  $env:CYPRESS_EXT_KITCHEN_PASSWORD = $kitchenCredential.GetNetworkCredential().Password

  if ($OrderId) {
    $env:CYPRESS_EXT_REFIRE_ORDER_ID = $OrderId
    $env:CYPRESS_EXT_REFIRE_SUPERVISOR_USERNAME = $adminCredential.UserName
    $env:CYPRESS_EXT_REFIRE_SUPERVISOR_PASSWORD = $adminCredential.GetNetworkCredential().Password
  }

  Push-Location (Split-Path -Parent $PSScriptRoot)
  try {
    & npx cypress run --browser chrome --headless --spec 'cypress/e2e/des_qa_05/des_qa_05_kds_refire_readonly_preflight.cy.js,cypress/e2e/des_qa_05/des_qa_05_orders_list_readonly_preflight.cy.js'
    $exitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
} finally {
  'CYPRESS_POS_BASE_URL', 'CYPRESS_POS_USERNAME', 'CYPRESS_POS_PASSWORD',
  'CYPRESS_EXT_KITCHEN_USERNAME', 'CYPRESS_EXT_KITCHEN_PASSWORD',
  'CYPRESS_EXT_REFIRE_ORDER_ID', 'CYPRESS_EXT_REFIRE_SUPERVISOR_USERNAME',
  'CYPRESS_EXT_REFIRE_SUPERVISOR_PASSWORD', 'CYPRESS_DES05_MENU_TOKEN',
  'CYPRESS_EXT_KITCHEN_TOKEN', 'CYPRESS_EXT_REFIRE_SUPERVISOR_TOKEN' |
    ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }
  $adminCredential = $null
  $kitchenCredential = $null
}

exit $exitCode
