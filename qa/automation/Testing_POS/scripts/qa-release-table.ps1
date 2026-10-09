# Staging QA only. Never use for a live payment environment.
# Explicitly scoped to ONE table and ONE known order. Dry-run by default.
# Example:
#   $env:POS_QA_CASHIER_TOKEN = Read-Host 'Cashier token'
#   $env:POS_QA_WAITER_TOKEN  = Read-Host 'Waiter token'
#   .\qa-release-table.ps1 -TableCode B1 -OrderId '<uuid>'
#   .\qa-release-table.ps1 -TableCode B1 -OrderId '<uuid>' -Execute -Confirm
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)][ValidateSet('B1','B2','B3','B4','B5','B6')][string]$TableCode,
    [Parameter(Mandatory)][guid]$OrderId,
    [string]$BaseUrl = 'http://160.191.47.17',
    [switch]$Execute
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$cashier = $env:POS_QA_CASHIER_TOKEN
$waiter = $env:POS_QA_WAITER_TOKEN
if ([string]::IsNullOrWhiteSpace($cashier) -or [string]::IsNullOrWhiteSpace($waiter)) {
    throw 'Set POS_QA_CASHIER_TOKEN and POS_QA_WAITER_TOKEN (do not commit or share tokens).'
}
$base = $BaseUrl.TrimEnd('/')
$cashHeaders = @{ Authorization = "Bearer $cashier" }
$waitHeaders = @{ Authorization = "Bearer $waiter" }

function Get-Tables {
    $response = Invoke-RestMethod -Method Get -Uri "$base/api/v1/tables" -Headers $waitHeaders -TimeoutSec 20
    return @($response)
}
function Get-Order {
    return Invoke-RestMethod -Method Get -Uri "$base/api/v1/orders/$OrderId" -Headers $cashHeaders -TimeoutSec 20
}
function Invoke-OrderAction([string]$Action) {
    $headers = @{ Authorization = "Bearer $cashier"; 'Idempotency-Key' = [guid]::NewGuid().ToString() }
    $null = Invoke-RestMethod -Method Post -Uri "$base/api/v1/orders/$OrderId/$Action" -Headers $headers -TimeoutSec 20
}

$matches = @(Get-Tables | Where-Object { $_.code -eq $TableCode })
if ($matches.Count -ne 1) { throw "Cannot identify $TableCode uniquely; nothing changed." }
$table = $matches[0]
if ($table.status -ne 'OCCUPIED') { throw "Expected OCCUPIED, got $($table.status). No changes made." }
if ([string]::IsNullOrWhiteSpace([string]$table.current_session_id)) {
    throw 'No current session ID; nothing changed.'
}
$order = Get-Order
if ([string]$order.session_id -ne [string]$table.current_session_id) {
    throw 'Order does not belong to active table session. No changes made.'
}
if ($order.status -notin @('SENT','SERVED','BILLING','PAID','CLOSED')) {
    throw "Unsupported order status $($order.status). Inspect manually; nothing changed."
}
Write-Host "TARGET: $TableCode session=$($table.current_session_id), order=$OrderId, status=$($order.status)"
Write-Warning 'This is for approved QA staging data only. It may create payment records (simulated gateway).'
if (-not $Execute) {
    Write-Host 'DRY RUN: no changes made. Add -Execute -Confirm only after checking order and authorization.'
    return
}
if (-not $PSCmdlet.ShouldProcess("$TableCode / $OrderId", 'Simulated billing, payment, close and mark-clean')) { return }

if ($order.status -in @('SENT','SERVED')) {
    Invoke-OrderAction 'request-billing'
    $order = Get-Order
    if ($order.status -ne 'BILLING') { throw "Billing not confirmed: $($order.status). Stop." }
}
if ($order.status -eq 'BILLING') {
    Invoke-OrderAction 'pay'
    $order = Get-Order
    if ($order.status -ne 'PAID') { throw "Payment not confirmed: $($order.status). Stop." }
}
if ($order.status -eq 'PAID') {
    Invoke-OrderAction 'close'
    $order = Get-Order
    if ($order.status -ne 'CLOSED') { throw "Close not confirmed: $($order.status). Stop." }
}

# Re-read table to confirm the session has been closed before marking clean.
$matches = @(Get-Tables | Where-Object { $_.code -eq $TableCode })
if ($matches.Count -ne 1 -or $matches[0].status -ne 'CLEANING') {
    throw "Expected CLEANING after close; got $($matches[0].status). Stop; do not force status."
}
$cleanHeaders = @{ Authorization = "Bearer $waiter"; 'Idempotency-Key' = [guid]::NewGuid().ToString() }
$null = Invoke-RestMethod -Method Post -Uri "$base/api/v1/tables/$($matches[0].id)/mark-clean" -Headers $cleanHeaders -TimeoutSec 20
$matches = @(Get-Tables | Where-Object { $_.code -eq $TableCode })
if ($matches.Count -ne 1 -or $matches[0].status -ne 'AVAILABLE') {
    throw 'Mark-clean response not verified as AVAILABLE. Check manually.'
}
Write-Host "SUCCESS: $TableCode AVAILABLE."
