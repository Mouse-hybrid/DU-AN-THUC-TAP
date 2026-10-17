param([string]$BaseUrl = 'http://160.191.47.17')

$ErrorActionPreference = 'Stop'
$base = $BaseUrl.TrimEnd('/')
if ($base -ne 'http://160.191.47.17') { throw 'Phase 1 audit is restricted to approved staging' }

$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\AFG_POS'
$evidenceLog = Join-Path $evidenceDir ("MORNING_READONLY_{0}.log" -f (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
function Record([string]$line) { $line | Tee-Object -FilePath $evidenceLog -Append }

$credential = $null
$pin = $null
$token = $null
$issues = 0
$missing = 0
$resultCode = 0
try {
  $before = (Invoke-RestMethod -Uri "$base/version" -TimeoutSec 20).commit
  if ($before -notmatch '^[0-9a-f]{40}$') { throw 'GET /version missing full commit' }
  Record "[Phase 1] Morning audit staging $($before.Substring(0, 12)); GET requests only"

  $openapi = Invoke-RestMethod -Uri "$base/openapi.json" -TimeoutSec 20
  $paths = @($openapi.paths.PSObject.Properties)
  $methods = @('get', 'post', 'put', 'patch', 'delete')
  $operations = 0
  foreach ($path in $paths) {
    $operations += @($path.Value.PSObject.Properties | Where-Object { $_.Name -in $methods }).Count
  }
  Record "[Phase 1] OpenAPI: $($paths.Count) paths; $operations REST operations"

  $credential = Get-Credential -UserName 'admin' -Message 'Supervisor PIN for read-only Phase 1 cleanup audit'
  if (-not $credential) { throw 'Credential prompt cancelled' }
  $pin = $credential.GetNetworkCredential().Password
  if (-not $pin) { throw 'PIN is empty' }
  $body = @{ username = 'admin'; password = $pin } | ConvertTo-Json -Compress
  try {
    $login = Invoke-RestMethod -Method Post -Uri "$base/api/v1/auth/login" -ContentType 'application/json' -Body $body -TimeoutSec 20
  } finally { $body = $null; $pin = $null }
  $token = $login.access_token
  if (-not $token) { throw 'Login response has no access token' }
  $headers = @{ Authorization = "Bearer $token" }
  $login = $null

  $tables = @(Invoke-RestMethod -Uri "$base/api/v1/tables" -Headers $headers -TimeoutSec 20)
  $b4 = @($tables | Where-Object { $_.code -eq 'B4' })
  if ($b4.Count -ne 1) { Record '[Phase 1] B4 INCONCLUSIVE: table absent or duplicated'; $missing++ }
  else {
    Record "[Phase 1] B4 status=$($b4[0].status); current_session_id=$($b4[0].current_session_id)"
    if ($b4[0].status -ne 'AVAILABLE' -or $b4[0].current_session_id) { $issues++ }
  }

  $menu = @(Invoke-RestMethod -Uri "$base/api/v1/menu?available_only=false" -Headers $headers -TimeoutSec 20)
  $expectedMenu = [ordered]@{
    'TC_EXT_006' = 'b800c6d9-2c86-4f73-86b7-23a044202de3'
    'TC_EXT_005' = '9bda107f-548e-4a85-b8af-655c35365c6d'
    'TC_PM_20'  = '89372555-ba28-44e4-862c-62f0052c246a'
  }
  foreach ($label in $expectedMenu.Keys) {
    $item = @($menu | Where-Object { $_.id -eq $expectedMenu[$label] })
    if ($item.Count -ne 1) { Record "[Phase 1] $label INCONCLUSIVE: historical QA menu item absent"; $missing++; continue }
    Record "[Phase 1] $label menu_id=$($item[0].id); is_available=$($item[0].is_available)"
    if ($item[0].is_available -ne $false) { $issues++ }
  }

  $expectedOrders = [ordered]@{
    'TC_EXT_010'    = '691f1ab5-2b6b-461e-8813-2fea8a4cde95'
    'TC_API_20_002' = 'acf6fbe4-4805-47d9-9637-3bad0335fc27'
  }
  foreach ($label in $expectedOrders.Keys) {
    try {
      $order = Invoke-RestMethod -Uri "$base/api/v1/orders/$($expectedOrders[$label])" -Headers $headers -TimeoutSec 20
      Record "[Phase 1] $label order_id=$($order.id); status=$($order.status)"
      if ($order.status -ne 'CLOSED') { $issues++ }
    } catch {
      $code = 0
      if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
      if ($code -ne 404) { throw 'Historical order GET failed; audit incomplete' }
      Record "[Phase 1] $label INCONCLUSIVE: historical order missing (HTTP 404)"
      $missing++
    }
  }

  $after = (Invoke-RestMethod -Uri "$base/version" -TimeoutSec 20).commit
  if ($after -ne $before) { throw 'Staging commit changed during audit' }
  if ($issues) { Record "[Phase 1] ATTENTION: $issues cleanup mismatch(es); inspect fixture ownership before any reset"; $resultCode = 1 }
  elseif ($missing) { Record "[Phase 1] INCONCLUSIVE: $missing historical fixture(s) absent; check whether staging data was reset"; $resultCode = 2 }
  else { Record '[Phase 1] PASS: B4 available; selected historical orders closed and QA menu items unavailable' }
} finally {
  $headers = $null
  $token = $null
  $pin = $null
  $credential = $null
  Write-Host "Phase 1 Terminal evidence: $evidenceLog"
  Write-Host '[Phase 1] Read-only audit; no business mutation or staging reset.'
}
exit $resultCode
