param(
  [string]$BaseUrl = 'http://160.191.47.17'
)

$ErrorActionPreference = 'Stop'
$origin = $BaseUrl.TrimEnd('/')
$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\DES-QA-05'
$evidenceLog = Join-Path $evidenceDir ("AUTH_{0}.log" -f (Get-Date -Format 'yyyy-MM-dd_HHmmss'))

function Get-LoginStatus {
  param([string]$Username, [string]$Password)
  $payload = @{ username = $Username; password = $Password } | ConvertTo-Json -Compress
  try {
    $response = Invoke-WebRequest -Uri "$origin/api/v1/auth/login" -Method Post `
      -ContentType 'application/json' -Body $payload -UseBasicParsing -TimeoutSec 20
    return [string][int]$response.StatusCode
  } catch {
    if ($_.Exception.Response) {
      return [string][int]$_.Exception.Response.StatusCode
    }
    return 'NETWORK_ERROR'
  } finally {
    $payload = $null
  }
}

$credential = Get-Credential -UserName 'admin' -Message 'Nhập mật khẩu chung của tài khoản seed trên STAGING do BE cấp'
if (-not $credential) { throw 'Credential prompt was cancelled.' }

try {
  $version = 'UNAVAILABLE'
  try {
    $info = Invoke-RestMethod -Uri "$origin/version" -Method Get -TimeoutSec 20
    if ($info.short_commit) { $version = [string]$info.short_commit }
  } catch {
    # Login statuses below are still useful when /version cannot be read.
  }

  $password = $credential.GetNetworkCredential().Password
  $statuses = [ordered]@{}
  foreach ($username in @('admin', 'kitchen', 'cashier', 'waiter')) {
    $statuses[$username] = Get-LoginStatus -Username $username -Password $password
  }

  $report = @(
    "[DES-QA-05] Staging version: $version"
    $(foreach ($username in $statuses.Keys) { "[DES-QA-05] POST /api/v1/auth/login username=$username HTTP $($statuses[$username])" })
    '[DES-QA-05] Credentials and tokens are excluded from this log.'
  )
  New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
  $report | Set-Content -Path $evidenceLog -Encoding UTF8
  $report | ForEach-Object { Write-Host $_ }
  Write-Host "[DES-QA-05] Evidence: $evidenceLog"

  if ($statuses['cashier'] -eq '200' -and $statuses['kitchen'] -eq '200') {
    Write-Host '[DES-QA-05] Cashier and Kitchen logins accepted; read-only PF-02, PF-03 and PF-12 can run.'
    if ($statuses['admin'] -ne '200') {
      Write-Host '[DES-QA-05] Supervisor account (username=admin) login unresolved; PF-04 requires an isolated order and authorized Supervisor login.'
    }
    Write-Host '[DES-QA-05] Run des05_run_authenticated_preflight.ps1 next.'
    $exitCode = 0
  } else {
    Write-Host '[DES-QA-05] Authentication unresolved; no menu, queue or order checks were executed.'
    $exitCode = 2
  }
} finally {
  $password = $null
  $credential = $null
}

exit $exitCode
