param([string]$BaseUrl = 'http://160.191.47.17')

$ErrorActionPreference = 'Stop'
$base = $BaseUrl.TrimEnd('/')
if ($base -ne 'http://160.191.47.17') { throw 'TC_EXT_019 is restricted to approved staging' }

$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\AFG_POS'
$evidenceLog = Join-Path $evidenceDir ("PF_OUTLET_019_{0}.log" -f (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
$credential = $null
$pin = $null

try {
  $credential = Get-Credential -UserName 'admin' -Message 'Shared staging QA PIN for six read-only login checks'
  if (-not $credential) { throw 'Credential prompt cancelled' }
  $pin = $credential.GetNetworkCredential().Password
  if (-not $pin) { throw 'Staging QA PIN is empty' }

  New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
  $before = (Invoke-RestMethod -Method Get -Uri "$base/version" -TimeoutSec 20).commit
  if ($before -notmatch '^[0-9a-f]{40}$') { throw 'GET /version missing full commit' }
  "[Phase 1] PF-OUTLET-019 staging $($before.Substring(0, 12)); account/outlet inventory only" |
    Tee-Object -FilePath $evidenceLog

  $accounts = @('admin', 'kitchen', 'cashier', 'waiter', 'qa2_admin', 'qa2_cashier')
  $found = @()
  foreach ($account in $accounts) {
    $body = @{ username = $account; password = $pin } | ConvertTo-Json -Compress
    try {
      $login = Invoke-RestMethod -Method Post -Uri "$base/api/v1/auth/login" -ContentType 'application/json' -Body $body -TimeoutSec 20
    } catch {
      "[Phase 1] PF-OUTLET-019 INCONCLUSIVE: login failed for $account; no response body logged" |
        Tee-Object -FilePath $evidenceLog -Append
      throw 'Account inventory incomplete; see non-sensitive evidence line above'
    } finally {
      $body = $null
    }
    if (-not $login.staff -or -not $login.staff.outlet_id -or $login.staff.username -ne $account) {
      throw "Login response missing expected staff/outlet_id for $account"
    }
    $found += [pscustomobject]@{
      Username = $account
      Role = [string]$login.staff.role
      OutletId = [string]$login.staff.outlet_id
    }
    $login = $null
  }

  $after = (Invoke-RestMethod -Method Get -Uri "$base/version" -TimeoutSec 20).commit
  if ($after -ne $before) { throw 'Staging changed during account inventory; result inconclusive' }
  foreach ($staff in $found) {
    "[Phase 1] PF-OUTLET-019 account=$($staff.Username) role=$($staff.Role) outlet_id=$($staff.OutletId)" |
      Tee-Object -FilePath $evidenceLog -Append
  }
  $outletCount = @($found | Select-Object -ExpandProperty OutletId -Unique).Count
  if ($outletCount -lt 2) {
    "[Phase 1] PF-OUTLET-019 BLOCKED: $outletCount distinct outlet among six QA accounts. TC_EXT_019 cross-outlet GET not executed." |
      Tee-Object -FilePath $evidenceLog -Append
  } else {
    "[Phase 1] PF-OUTLET-019 READY: $outletCount distinct outlets. TC_EXT_019 can discover a seeded Q2-1 NEW order if present." |
      Tee-Object -FilePath $evidenceLog -Append
  }
} finally {
  $pin = $null
  $credential = $null
}

Write-Host "Phase 1 Terminal evidence: $evidenceLog"
Write-Host '[Phase 1] Only login and /version requests executed; no business mutation.'
