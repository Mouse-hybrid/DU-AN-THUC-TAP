# One-off recovery of the TSK-QA-010 fixture interrupted on 2026-10-22.
# Scoped to the exact staging build, table, session, order, item and ticket.
param([switch]$Execute)
$ErrorActionPreference = 'Stop'
$base = 'http://160.191.47.17'
$expectedCommit = '1c41cce58de2d9637f318e11cddae424f76d9278'
$tableId = 'f0f1e9d9-f6a9-46bb-b621-4bf3c05ce438'
$sessionId = 'b7bb4838-0595-4c9f-8fd3-d2e8fb3bf7bb'
$orderId = 'b6ac543b-501d-4b10-b6d2-5e193ed9b78b'
$itemId = 'f1546e98-3e70-42f2-ad99-4bccf90fb8aa'
$ticketId = 'dd66afd4-b904-4263-bf5e-7bd54a150dff'
$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\DES-QA-06'
$evidenceLog = Join-Path $evidenceDir ("TSK_QA_010_RECOVER_B1_{0}.log" -f (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
function Record([string]$line) { $line | Tee-Object -FilePath $evidenceLog -Append }

$before = [string](Invoke-RestMethod -Uri "$base/version" -TimeoutSec 20).commit
if ($before -ne $expectedCommit) { throw "Staging build changed to $before; recovery not started" }
$credential = Get-Credential -UserName 'waiter' -Message 'Shared staging PIN for recovery of the one owned TSK-QA-010 B1 fixture'
if (-not $credential) { throw 'Credential prompt cancelled' }
$pin = $credential.GetNetworkCredential().Password
if (-not $pin) { throw 'Staging PIN is empty' }
$tokens = @{}
try {
  foreach ($role in @('waiter', 'cashier', 'kitchen')) {
    $body = @{ username = $role; password = $pin } | ConvertTo-Json -Compress
    $login = Invoke-RestMethod -Method Post -Uri "$base/api/v1/auth/login" `
      -ContentType 'application/json' -Body $body -TimeoutSec 20
    if (-not $login.access_token) { throw "$role login returned no token" }
    $tokens[$role] = [string]$login.access_token
  }
  $waitHeaders = @{ Authorization = "Bearer $($tokens.waiter)" }
  $kitchenHeaders = @{ Authorization = "Bearer $($tokens.kitchen)" }
  [object[]]$tables = Invoke-RestMethod -Uri "$base/api/v1/tables" -Headers $waitHeaders -TimeoutSec 20
  $matches = @($tables | Where-Object { $_.code -eq 'B1' })
  if ($matches.Count -ne 1) { throw "Expected one B1 table, found $($matches.Count); no mutation" }
  $table = $matches[0]
  Record "[TSK-QA-010] OBSERVED B1: id=$($table.id); status=$($table.status); session=$($table.current_session_id); expected_id=$tableId; expected_session=$sessionId"
  if ([string]$table.id -ne $tableId -or $table.status -ne 'OCCUPIED' -or
      [string]$table.current_session_id -ne $sessionId) {
    throw "B1 no longer matches owned session $sessionId; no mutation"
  }
  $order = Invoke-RestMethod -Uri "$base/api/v1/orders/$orderId" -Headers $waitHeaders -TimeoutSec 20
  if ([string]$order.id -ne $orderId -or [string]$order.table_session_id -ne $sessionId -or
      $order.status -ne 'SENT') { throw 'Order identity/session/status changed; no mutation' }
  $items = @($order.items)
  if ($items.Count -ne 1 -or [string]$items[0].id -ne $itemId -or
      [string]$items[0].note -notmatch '^TSK-QA-010-SLA-' -or
      $items[0].status -ne 'PREPARING') {
    throw 'Item identity, QA note or PREPARING status changed; no mutation'
  }
  [object[]]$queue = Invoke-RestMethod -Uri "$base/api/v1/kitchen/queue?status=IN_PROGRESS" `
    -Headers $kitchenHeaders -TimeoutSec 20
  $ownTickets = @($queue | Where-Object {
    [string]$_.id -eq $ticketId -and [string]$_.order_id -eq $orderId -and
    [string]$_.order_item_id -eq $itemId
  })
  if ($ownTickets.Count -ne 1) { throw 'Owned IN_PROGRESS ticket not found uniquely; no mutation' }
  $confirmVersion = [string](Invoke-RestMethod -Uri "$base/version" -TimeoutSec 20).commit
  if ($confirmVersion -ne $before) { throw 'Staging build changed before cleanup; no mutation' }
  Record "[TSK-QA-010] OWNERSHIP VERIFIED: B1 $sessionId; order $orderId SENT; item $itemId PREPARING; ticket $ticketId IN_PROGRESS; staging $($before.Substring(0, 12))"
  if (-not $Execute) {
    Record '[TSK-QA-010] DRY RUN PASS: all target IDs verified; no mutation. Re-run with -Execute to recover this owned fixture.'
    return
  }

  $env:POS_QA_CASHIER_TOKEN = $tokens.cashier
  $env:POS_QA_WAITER_TOKEN = $tokens.waiter
  & (Join-Path $PSScriptRoot 'qa-release-table.ps1') -TableCode B1 -OrderId $orderId `
    -BaseUrl $base -Execute -Confirm:$false 2>&1 | Tee-Object -FilePath $evidenceLog -Append

  $finalOrder = Invoke-RestMethod -Uri "$base/api/v1/orders/$orderId" -Headers $waitHeaders -TimeoutSec 20
  [object[]]$finalTables = Invoke-RestMethod -Uri "$base/api/v1/tables" -Headers $waitHeaders -TimeoutSec 20
  $finalB1 = @($finalTables | Where-Object { $_.code -eq 'B1' -and [string]$_.id -eq $tableId })
  if ($finalOrder.status -ne 'CLOSED' -or $finalB1.Count -ne 1 -or
      $finalB1[0].status -ne 'AVAILABLE' -or $finalB1[0].current_session_id) {
    throw 'CLEANUP REQUIRED: final order/table state not verified'
  }
  $after = [string](Invoke-RestMethod -Uri "$base/version" -TimeoutSec 20).commit
  if ($after -ne $before) { throw 'INCONCLUSIVE: staging build changed during cleanup' }
  Record "[TSK-QA-010] CLEANUP PASS: B1 AVAILABLE; order $orderId CLOSED; previous SLA run remains INTERRUPTED"
} finally {
  Remove-Item Env:POS_QA_CASHIER_TOKEN, Env:POS_QA_WAITER_TOKEN -ErrorAction SilentlyContinue
  $tokens.Clear()
  $pin = $null
  $credential = $null
  Write-Host "TSK-QA-010 recovery evidence: $evidenceLog"
}
