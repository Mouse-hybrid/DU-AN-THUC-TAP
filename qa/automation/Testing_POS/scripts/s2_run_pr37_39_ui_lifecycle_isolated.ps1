param([string]$BaseUrl = 'http://160.191.47.17')

$ErrorActionPreference = 'Stop'
$base = $BaseUrl.TrimEnd('/')
if ($base -ne 'http://160.191.47.17') { throw 'S2 UI lifecycle is restricted to approved staging' }
$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\EXE-QA-04'
$evidenceLog = Join-Path $evidenceDir ("S2_PR37_39_UI_LIFECYCLE_{0}.log" -f (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
$credential = Get-Credential -UserName 'waiter' -Message 'Shared staging PIN for one isolated QA lifecycle with simulated payment'
if (-not $credential) { throw 'Credential prompt cancelled' }
$pin = $credential.GetNetworkCredential().Password
if (-not $pin) { throw 'Staging PIN is empty' }

New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
$before = (Invoke-RestMethod -Method Get -Uri "$base/version" -TimeoutSec 20).commit
if ($before -notmatch '^[0-9a-f]{40}$') { throw 'GET /version missing full commit' }
"[S2-UI] Lifecycle start $($before.Substring(0, 12)); only fresh AVAILABLE B1-B4; simulated staging payment" |
  Tee-Object -FilePath $evidenceLog
$exitCode = 1
try {
  $auth = Invoke-RestMethod -Method Post -Uri "$base/api/v1/auth/login" -ContentType 'application/json' `
    -Body (@{username='waiter';password=$pin} | ConvertTo-Json -Compress) -TimeoutSec 20
  $headers = @{Authorization="Bearer $($auth.access_token)"}
  $tables = @(Invoke-RestMethod -Method Get -Uri "$base/api/v1/tables" -Headers $headers -TimeoutSec 20)
  $available = @($tables | Where-Object { $_.code -match '^B[1-4]$' -and $_.status -eq 'AVAILABLE' })
  $states = @($tables | Where-Object { $_.code -match '^B[1-4]$' } | ForEach-Object { "$($_.code):$($_.status)" }) -join ', '
  "[S2-UI] Fixture gate: $states; available $($available.Count)" | Tee-Object -FilePath $evidenceLog -Append
  if ($available.Count -eq 0) {
    '[S2-UI] PENDING: no AVAILABLE B1-B4; no UI business mutation' | Tee-Object -FilePath $evidenceLog -Append
    $exitCode = 0
  } else {
    $menu = @(Invoke-RestMethod -Method Get -Uri "$base/api/v1/menu?available_only=true" -Headers $headers -TimeoutSec 20)
    $mapped = @($menu | Where-Object { $_.is_available -eq $true -and $_.station_id })
    "[S2-UI] Fixture gate: $($mapped.Count) available mapped item(s)" | Tee-Object -FilePath $evidenceLog -Append
    if ($mapped.Count -eq 0) {
      '[S2-UI] PENDING: no available mapped menu item; no UI business mutation' |
        Tee-Object -FilePath $evidenceLog -Append
      $exitCode = 0
    } else {
      $env:BASE_URL = $base
      $env:S2_STAGING_PIN = $pin
      Push-Location (Split-Path -Parent $PSScriptRoot)
      try {
        $priorConsole = [Console]::OutputEncoding
        $priorOutput = $OutputEncoding
        [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
        $OutputEncoding = [Console]::OutputEncoding
        try {
          & npx playwright test test_playwright_version/s2_pr37_39_ui_lifecycle_isolated.spec.ts --project=chromium 2>&1 |
            Tee-Object -FilePath $evidenceLog -Append
          $exitCode = $LASTEXITCODE
        } finally {
          [Console]::OutputEncoding = $priorConsole
          $OutputEncoding = $priorOutput
        }
      } finally { Pop-Location }
    }
  }
  $after = (Invoke-RestMethod -Method Get -Uri "$base/version" -TimeoutSec 20).commit
  if ($after -ne $before) {
    '[S2-UI] INCONCLUSIVE: staging build changed during run' | Tee-Object -FilePath $evidenceLog -Append
    $exitCode = 1
  }
} finally {
  Remove-Item Env:BASE_URL, Env:S2_STAGING_PIN -ErrorAction SilentlyContinue
  $pin = $null
  $credential = $null
}

Write-Host "S2 UI Terminal evidence: $evidenceLog"
Write-Host '[S2-UI] Report the business result only if Playwright executes and own order/table cleanup succeeds.'
exit $exitCode
