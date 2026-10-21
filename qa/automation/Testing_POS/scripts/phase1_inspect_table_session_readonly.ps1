param(
  [ValidateSet('B1', 'B2', 'B3', 'B4', 'B5', 'B6')][string]$TableCode = 'B4',
  [string]$ExpectedSessionId = '',
  [string]$BaseUrl = 'http://160.191.47.17'
)

$ErrorActionPreference = 'Stop'
$base = $BaseUrl.TrimEnd('/')
if ($base -ne 'http://160.191.47.17') { throw 'This inventory is restricted to approved staging' }

$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\AFG_POS'
$evidenceLog = Join-Path $evidenceDir ("TABLE_SESSION_READONLY_{0}_{1}.log" -f $TableCode, (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
function Record([string]$line) { $line | Tee-Object -FilePath $evidenceLog -Append }

$credential = $null
$pin = $null
$body = $null
$token = $null
$headers = $null
try {
  $before = (Invoke-RestMethod -Uri "$base/version" -TimeoutSec 20).commit
  if ($before -notmatch '^[0-9a-f]{40}$') { throw 'GET /version missing full commit' }
  Record "[Phase 1] Table-session inspection: staging $($before.Substring(0, 12)); $TableCode; login plus GET only"

  $credential = Get-Credential -UserName 'admin' -Message 'Supervisor PIN for read-only table-session inspection'
  if (-not $credential) { throw 'Credential prompt cancelled' }
  $pin = $credential.GetNetworkCredential().Password
  if (-not $pin) { throw 'PIN is empty' }
  $body = @{ username = 'admin'; password = $pin } | ConvertTo-Json -Compress
  try {
    $login = Invoke-RestMethod -Method Post -Uri "$base/api/v1/auth/login" -ContentType 'application/json' -Body $body -TimeoutSec 20
  } finally { $body = $null; $pin = $null }
  $token = $login.access_token
  $login = $null
  if (-not $token) { throw 'Login response has no access token' }
  $headers = @{ Authorization = "Bearer $token" }

  $tables = Invoke-RestMethod -Uri "$base/api/v1/tables" -Headers $headers -TimeoutSec 20
  $matches = @($tables | Where-Object { $_.code -eq $TableCode })
  if ($matches.Count -ne 1) { throw "Expected exactly one $TableCode table; found $($matches.Count)" }
  $table = $matches[0]
  $detail = Invoke-RestMethod -Uri "$base/api/v1/tables/$($table.id)" -Headers $headers -TimeoutSec 20
  if ([string]$detail.id -ne [string]$table.id -or [string]$detail.code -ne $TableCode) {
    throw 'Table dashboard and detail disagree; no ownership conclusion'
  }

  Record "[Phase 1] $TableCode table_id=$($table.id); status=$($table.status); dashboard_session=$($table.current_session_id)"
  if ($ExpectedSessionId -and [string]$table.current_session_id -ne $ExpectedSessionId) {
    Record "[Phase 1] SESSION CHANGED: expected $ExpectedSessionId; inspect current state before using older evidence"
  }
  if (-not $detail.current_session) {
    Record "[Phase 1] $TableCode has no OPEN session in table detail; orders in detail=$(@($detail.orders).Count)"
  } else {
    $session = $detail.current_session
    if ([string]$session.id -ne [string]$table.current_session_id) {
      throw 'Table dashboard and detail session IDs disagree; no ownership conclusion'
    }
    Record "[Phase 1] OPEN session=$($session.id); opened_at=$($session.opened_at); guest_count=$($session.guest_count)"
    $orders = @($detail.orders)
    Record "[Phase 1] $TableCode current-session order count=$($orders.Count)"
    foreach ($order in $orders) {
      if ([string]$order.table_session_id -ne [string]$session.id) {
        throw "Order $($order.id) belongs to a different session; no ownership conclusion"
      }
      Record "[Phase 1] order=$($order.id); status=$($order.status); created_at=$($order.created_at); version=$($order.current_version); item_count=$(@($order.items).Count)"
    }
    Record '[Phase 1] Ownership UNVERIFIED: compare session/order IDs and timestamps against QA evidence before any cleanup'
  }

  $after = (Invoke-RestMethod -Uri "$base/version" -TimeoutSec 20).commit
  if ($after -ne $before) { throw 'Staging build changed during inspection; discard this snapshot' }
} finally {
  $headers = $null
  $token = $null
  $pin = $null
  $body = $null
  $credential = $null
  Write-Host "Phase 1 Terminal evidence: $evidenceLog"
  Write-Host '[Phase 1] Read-only inspection; no order, table, or staging fixture changed.'
}
