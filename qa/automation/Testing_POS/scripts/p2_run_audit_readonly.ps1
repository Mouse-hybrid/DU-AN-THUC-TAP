param(
  [Parameter(Mandatory = $true)][string]$OrderId,
  [string]$BaseUrl = 'http://160.191.47.17',
  [string]$ExpectedCommit = '',
  [string]$SupervisorUser = 'admin',
  [string]$CashierUser = 'cashier',
  [string]$WaiterUser = 'waiter',
  [string]$KitchenUser = 'kitchen',
  [string]$OtherOutletSupervisorUser = 'qa2_admin'
)

$ErrorActionPreference = 'Stop'
if ($OrderId -notmatch '^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$') {
  throw 'OrderId must be an existing owned CLOSED QA order UUID.'
}
if ($ExpectedCommit -and $ExpectedCommit -notmatch '^[0-9a-fA-F]{7,40}$') {
  throw 'ExpectedCommit must be a real 7-40 character Git SHA prefix.'
}
if (-not $ExpectedCommit) {
  $ExpectedCommit = [string](Invoke-RestMethod -Uri ($BaseUrl.TrimEnd('/') + '/version') -TimeoutSec 15).commit
  if ($ExpectedCommit -notmatch '^[0-9a-fA-F]{7,40}$') { throw 'Cannot determine staging build.' }
}
$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\SPRINT4'
New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
$stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
$output = [IO.Path]::GetFullPath((Join-Path $evidenceDir "P2_AUD_001_002_003_READONLY_$stamp.json"))
$credential = $null
$config = $null
$payload = $null
$exitCode = 1
$previousOutput = $OutputEncoding
try {
  Write-Host "[Phase 2] Read-only audit; target order $OrderId; build $ExpectedCommit"
  $credential = Get-Credential -UserName $SupervisorUser -Message 'Common staging QA seed password (admin/cashier/waiter/kitchen and QA 2). Not recorded in evidence.'
  if (-not $credential) { throw 'Credential entry cancelled; no business tests executed.' }
  $config = @{
    baseUrl = $BaseUrl; expectedCommit = $ExpectedCommit; orderId = $OrderId
    supervisorUser = $SupervisorUser; cashierUser = $CashierUser; waiterUser = $WaiterUser
    kitchenUser = $KitchenUser; otherOutletSupervisorUser = $OtherOutletSupervisorUser
    password = $credential.GetNetworkCredential().Password
    runId = ('RUN-{0}-P2AUD001002003-{1}' -f (Get-Date -Format 'yyyyMMdd'), (Get-Date -Format 'HHmmss'))
    output = $output
  }
  $payload = $config | ConvertTo-Json -Compress
  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $payload | & node (Join-Path $PSScriptRoot 'p2_audit_readonly.mjs')
  $exitCode = $LASTEXITCODE
} finally {
  if ($config) { $config.password = $null }
  $payload = $null; $credential = $null; $config = $null
  $OutputEncoding = $previousOutput
}
Write-Host "[Phase 2] Exit 0 = all Passed; 1 = failure/runner error; 2 = Pending/Blocked. Read the per-case result."
exit $exitCode
