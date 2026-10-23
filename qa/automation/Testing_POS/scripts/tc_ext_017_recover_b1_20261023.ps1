# One-off, exact-fixture recovery for TC_EXT_017 payment UI run on 2026-10-23.
# Dry-run by default. Only approved staging; the PIN is prompted and never logged.
[CmdletBinding()]
param([switch]$Execute)

$ErrorActionPreference = 'Stop'
$base = 'http://160.191.47.17'
$expectedCommit = '46d6049b7228'
$tableId = 'f0f1e9d9-f6a9-46bb-b621-4bf3c05ce438'
$sessionId = '053a9bc9-8af6-4050-a762-f2adcc9bbe6d'
$orderId = '892eb29c-3c09-4472-a022-5dd9ab359bb6'
$itemId = '069cfb44-36f8-422d-8902-38208465afd0'
$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\AFG_POS'
New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
$evidenceLog = Join-Path $evidenceDir ("TC_EXT_017_RECOVER_B1_{0}.log" -f (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
function Record([string]$line) { $line | Tee-Object -FilePath $evidenceLog -Append }
function Version {
  $commit = [string](Invoke-RestMethod -Uri "$base/version" -TimeoutSec 20).commit
  if ($commit -notmatch '^[0-9a-f]{40}$' -or
      -not $commit.StartsWith($expectedCommit, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Staging commit $commit differs from expected $expectedCommit; no further mutation"
  }
  return $commit
}
$credential = $null
$pin = $null
$tokens = @{}
try {
  $before = Version
  $credential = Get-Credential -UserName 'waiter' -Message 'QA staging PIN for TC_EXT_017 exact B1 fixture'
  if (-not $credential) { throw 'Credential prompt cancelled' }
  $pin = $credential.GetNetworkCredential().Password
  if (-not $pin) { throw 'Empty PIN' }
  foreach ($role in @('waiter', 'cashier')) {
    $body = @{ username = $role; password = $pin } | ConvertTo-Json -Compress
    $login = Invoke-RestMethod -Method Post -Uri "$base/api/v1/auth/login" -ContentType 'application/json' -Body $body -TimeoutSec 20
    if (-not $login.access_token) { throw "$role login returned no token" }
    $tokens[$role] = [string]$login.access_token
    $body = $null
    $login = $null
  }
  $pin = $null
  $credential = $null
  $waiterHeaders = @{ Authorization = "Bearer $($tokens.waiter)" }
  $cashierHeaders = @{ Authorization = "Bearer $($tokens.cashier)" }

  $tables = @(Invoke-RestMethod -Uri "$base/api/v1/tables" -Headers $waiterHeaders -TimeoutSec 20)
  $matched = @($tables | Where-Object { $_.code -eq 'B1' -and [string]$_.id -eq $tableId })
  if ($matched.Count -ne 1) { throw 'B1 table identity changed; no mutation' }
  $table = Invoke-RestMethod -Uri "$base/api/v1/tables/$tableId" -Headers $waiterHeaders -TimeoutSec 20
  $order = Invoke-RestMethod -Uri "$base/api/v1/orders/$orderId" -Headers $waiterHeaders -TimeoutSec 20
  if ([string]$order.id -ne $orderId -or [string]$order.table_session_id -ne $sessionId) {
    throw 'Order identity or owned session changed; no mutation'
  }
  if (@($order.items).Count -ne 1 -or [string]$order.items[0].id -ne $itemId -or
      $order.items[0].status -ne 'SERVED') {
    throw 'Owned SERVED item no longer matches; no mutation'
  }
  if ([string]$table.id -ne $tableId -or [string]$table.code -ne 'B1' -or
      $matched[0].status -ne $table.status -or
      $matched[0].current_session_id -or $table.current_session) {
    throw 'B1 identity/status/current session differs; no mutation'
  }
  if ($table.status -eq 'AVAILABLE' -and $order.status -eq 'CLOSED') {
    Record "[TC_EXT_017] ALREADY CLEAN: B1 AVAILABLE; order $orderId CLOSED; no mutation"
    return
  }
  if ($table.status -ne 'CLEANING' -or $order.status -notin @('PAID', 'CLOSED')) {
    throw "Unexpected B1=$($table.status), order=$($order.status); no mutation"
  }
  $detailOrders = @($table.orders)
  if ($detailOrders.Count -gt 0) {
    throw "B1 detail has $($detailOrders.Count) order(s) despite no current session; inspect before cleanup"
  }
  if ((Version) -ne $before) { throw 'Staging changed during ownership check; no mutation' }
  Record "[TC_EXT_017] OWNERSHIP VERIFIED: B1 CLEANING; no current session; order $orderId $($order.status); owned session $sessionId; item $itemId SERVED; staging $($before.Substring(0, 12))"
  if (-not $Execute) {
    Record '[TC_EXT_017] DRY RUN PASS: no mutation. Re-run with -Execute to close the owned order and mark B1 clean.'
    return
  }

  if ($order.status -eq 'PAID') {
    $headers = @{ Authorization = "Bearer $($tokens.cashier)"; 'Idempotency-Key' = [guid]::NewGuid().ToString() }
    $null = Invoke-RestMethod -Method Post -Uri "$base/api/v1/orders/$orderId/close" -Headers $headers -TimeoutSec 20
  }
  $closed = Invoke-RestMethod -Uri "$base/api/v1/orders/$orderId" -Headers $waiterHeaders -TimeoutSec 20
  if ($closed.status -ne 'CLOSED' -or [string]$closed.table_session_id -ne $sessionId) {
    throw 'CLEANUP REQUIRED: order close was not verified; B1 remains untouched'
  }
  $current = Invoke-RestMethod -Uri "$base/api/v1/tables/$tableId" -Headers $waiterHeaders -TimeoutSec 20
  if ([string]$current.id -ne $tableId -or $current.status -ne 'CLEANING' -or $current.current_session) {
    throw 'CLEANUP REQUIRED: B1 changed after close; mark-clean not attempted'
  }
  if ((Version) -ne $before) { throw 'Staging changed after order close; mark-clean not attempted' }
  $headers = @{ Authorization = "Bearer $($tokens.waiter)"; 'Idempotency-Key' = [guid]::NewGuid().ToString() }
  $null = Invoke-RestMethod -Method Post -Uri "$base/api/v1/tables/$tableId/mark-clean" -Headers $headers -TimeoutSec 20
  $finalTable = Invoke-RestMethod -Uri "$base/api/v1/tables/$tableId" -Headers $waiterHeaders -TimeoutSec 20
  $finalOrder = Invoke-RestMethod -Uri "$base/api/v1/orders/$orderId" -Headers $waiterHeaders -TimeoutSec 20
  if ($finalTable.status -ne 'AVAILABLE' -or $finalTable.current_session -or $finalOrder.status -ne 'CLOSED') {
    throw 'CLEANUP REQUIRED: final B1 AVAILABLE and order CLOSED not verified'
  }
  if ((Version) -ne $before) { throw 'INCONCLUSIVE: staging changed during cleanup' }
  Record "[TC_EXT_017] CLEANUP PASS: B1 AVAILABLE; order $orderId CLOSED; earlier run remains interrupted"
} finally {
  $tokens.Clear()
  $pin = $null
  $credential = $null
  Write-Host "TC_EXT_017 recovery evidence: $evidenceLog"
}
