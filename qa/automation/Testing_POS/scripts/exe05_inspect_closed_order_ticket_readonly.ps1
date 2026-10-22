param(
  [Parameter(Mandatory)][guid]$OrderId,
  [Parameter(Mandatory)][guid]$TicketId,
  [string]$ExpectedCommit = '',
  [string]$BaseUrl = 'http://160.191.47.17'
)

# Scoped diagnostic, not a contract assertion. POST is used only for login.
$ErrorActionPreference = 'Stop'
$base = $BaseUrl.TrimEnd('/')
if ($base -ne 'http://160.191.47.17') { throw 'Diagnostic is restricted to approved staging' }
if ($ExpectedCommit -and $ExpectedCommit -notmatch '^[0-9a-fA-F]{7,40}$') {
  throw 'ExpectedCommit must be a 7-40 character Git commit prefix'
}

$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\EXE-QA-05'
$evidenceLog = Join-Path $evidenceDir ("CLOSED_ORDER_TICKET_READONLY_{0}.log" -f (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
$credential = $null
$pin = $null
$tokens = @{}
try {
  $before = [string](Invoke-RestMethod -Uri "$base/version" -TimeoutSec 20).commit
  if ($before -notmatch '^[0-9a-f]{40}$') { throw 'GET /version did not return a full commit SHA' }
  if ($ExpectedCommit -and -not $before.StartsWith($ExpectedCommit, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Staging commit $before differs from expected $ExpectedCommit"
  }

  $credential = Get-Credential -UserName 'kitchen' -Message 'Shared staging PIN for read-only ticket inspection'
  if (-not $credential) { throw 'Credential prompt cancelled' }
  $pin = $credential.GetNetworkCredential().Password
  if (-not $pin) { throw 'Staging PIN is empty' }
  foreach ($role in @('kitchen','admin')) {
    $login = Invoke-RestMethod -Method Post -Uri "$base/api/v1/auth/login" -ContentType 'application/json' `
      -Body (@{ username = $role; password = $pin } | ConvertTo-Json -Compress) -TimeoutSec 20
    if (-not $login.access_token) { throw "$role login returned no token" }
    $tokens[$role] = [string]$login.access_token
  }
  $adminHeader = @{ Authorization = "Bearer $($tokens.admin)" }
  $kitchenHeader = @{ Authorization = "Bearer $($tokens.kitchen)" }
  $order = Invoke-RestMethod -Method Get -Uri "$base/api/v1/orders/$OrderId" -Headers $adminHeader -TimeoutSec 20
  if ([string]$order.id -ne [string]$OrderId) { throw 'Order ID mismatch; no conclusion' }
  $active = @(Invoke-RestMethod -Method Get -Uri "$base/api/v1/kitchen/queue" -Headers $kitchenHeader -TimeoutSec 20)
  $progress = @(Invoke-RestMethod -Method Get -Uri "$base/api/v1/kitchen/queue?status=IN_PROGRESS" -Headers $kitchenHeader -TimeoutSec 20)
  $done = @(Invoke-RestMethod -Method Get -Uri "$base/api/v1/kitchen/queue?status=DONE" -Headers $kitchenHeader -TimeoutSec 20)
  $cancelled = @(Invoke-RestMethod -Method Get -Uri "$base/api/v1/kitchen/queue?status=CANCELLED" -Headers $kitchenHeader -TimeoutSec 20)
  $matches = @($progress + $done + $cancelled | Where-Object { [string]$_.id -eq [string]$TicketId })
  $byStatus = @($matches | Group-Object -Property status | ForEach-Object { "{0}:{1}" -f $_.Name,$_.Count }) -join ', '
  $inDefaultQueue = @($active | Where-Object { [string]$_.id -eq [string]$TicketId }).Count -gt 0
  $otherOrder = @($matches | Where-Object { [string]$_.order_id -ne [string]$OrderId })
  if ($otherOrder.Count) { throw 'Ticket belongs to another order; no conclusion' }
  $after = [string](Invoke-RestMethod -Uri "$base/version" -TimeoutSec 20).commit
  New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
  "[EXE-QA-05] Read-only diagnostic build $before; order $OrderId status=$($order.status); ticket $TicketId in_default_queue=$inDefaultQueue; status_matches=$($matches.Count) [$byStatus]" |
    Tee-Object -FilePath $evidenceLog
  if ($before -ne $after) {
    '[EXE-QA-05] INCONCLUSIVE: staging build changed during diagnostic' | Tee-Object -FilePath $evidenceLog -Append
  } elseif ($order.status -eq 'CLOSED' -and @($progress | Where-Object { [string]$_.id -eq [string]$TicketId }).Count -gt 0) {
    '[EXE-QA-05] ATTENTION: CLOSED order still has an IN_PROGRESS ticket. Confirm expected close behavior with BE/PO; this diagnostic is not a business testcase verdict.' |
      Tee-Object -FilePath $evidenceLog -Append
  } else {
    '[EXE-QA-05] OBSERVED: no CLOSED/IN_PROGRESS combination for the selected IDs at this instant.' |
      Tee-Object -FilePath $evidenceLog -Append
  }
  Write-Host "EXE-QA-05 Diagnostic evidence: $evidenceLog"
} finally {
  $pin = $null
  $credential = $null
  if ($tokens) { $tokens.Clear() }
}
