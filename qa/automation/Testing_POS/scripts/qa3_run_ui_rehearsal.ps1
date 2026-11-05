param(
  [string]$ExpectedCommit,
  [string]$BaseUrl = 'http://160.191.47.17'
)

$ErrorActionPreference = 'Stop'
$base = $BaseUrl.TrimEnd('/')
if ($base -ne 'http://160.191.47.17') { throw 'QA 3 rehearsal is restricted to approved staging' }
if ($ExpectedCommit -and $ExpectedCommit -notmatch '^[0-9a-f]{7,40}$') {
  throw 'ExpectedCommit must be a Git commit prefix (7-40 hex characters)'
}

$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\UAT'
$stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
$evidenceLog = Join-Path $evidenceDir ("QA3_REHEARSAL_{0}.log" -f $stamp)
$imageDir = Join-Path $evidenceDir ("QA3_REHEARSAL_IMAGES_{0}" -f $stamp)
$credential = $null
$pin = $null
$exitCode = 1

try {
  $before = (Invoke-RestMethod -Method Get -Uri "$base/version" -TimeoutSec 20).commit
  if ($before -notmatch '^[0-9a-f]{40}$') { throw 'GET /version missing full commit' }
  if ($ExpectedCommit -and -not ($before.StartsWith($ExpectedCommit))) {
    throw "Staging build $before does not match ExpectedCommit $ExpectedCommit"
  }
  $credential = Get-Credential -UserName 'qa3_waiter' -Message 'QA 3 seed PIN for isolated UI rehearsal'
  if (-not $credential) { throw 'Credential prompt cancelled' }
  $pin = $credential.GetNetworkCredential().Password
  if (-not $pin) { throw 'QA 3 seed PIN is empty' }

  New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
  "[QA3] Readiness start $($before.Substring(0, 12)); Q3-1..Q3-3 only; QA rehearsal, not user UAT" |
    Tee-Object -FilePath $evidenceLog
  $auth = Invoke-RestMethod -Method Post -Uri "$base/api/v1/auth/login" -ContentType 'application/json' `
    -Body (@{username='qa3_waiter'; password=$pin} | ConvertTo-Json -Compress) -TimeoutSec 20
  if (-not $auth.access_token) { throw 'qa3_waiter login returned no access token' }
  $headers = @{Authorization="Bearer $($auth.access_token)"}
  $tables = Invoke-RestMethod -Method Get -Uri "$base/api/v1/tables" -Headers $headers -TimeoutSec 20
  $qaTables = @($tables | Where-Object { $_.code -match '^Q3-[1-3]$' })
  $available = @($qaTables | Where-Object { $_.status -eq 'AVAILABLE' })
  $states = @($qaTables | ForEach-Object { "$($_.code):$($_.status)" }) -join ', '
  $menu = Invoke-RestMethod -Method Get -Uri "$base/api/v1/menu?available_only=true" `
    -Headers $headers -TimeoutSec 20
  $mapped = @($menu | Where-Object { $_.is_available -eq $true -and $_.station_id })
  "[QA3] Fixture gate: $states; available $($available.Count); mapped menu $($mapped.Count)" |
    Tee-Object -FilePath $evidenceLog -Append

  if ($qaTables.Count -ne 3 -or $available.Count -eq 0 -or $mapped.Count -eq 0) {
    '[QA3] PENDING: fixture gate failed; no business mutation' |
      Tee-Object -FilePath $evidenceLog -Append
    $exitCode = 2
  } else {
    $env:BASE_URL = $base
    $env:S2_STAGING_PIN = $pin
    $env:QA3_REHEARSAL = 'true'
    $env:QA_UI_EVIDENCE_DIR = $imageDir
    Push-Location (Split-Path -Parent $PSScriptRoot)
    try {
      $priorConsole = [Console]::OutputEncoding
      $priorOutput = $OutputEncoding
      [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
      $OutputEncoding = [Console]::OutputEncoding
      try {
        & npx playwright test test_playwright_version/s2_pr37_39_ui_lifecycle_isolated.spec.ts `
          --project=chromium 2>&1 | Tee-Object -FilePath $evidenceLog -Append
        $exitCode = $LASTEXITCODE
      } finally {
        [Console]::OutputEncoding = $priorConsole
        $OutputEncoding = $priorOutput
      }
    } finally { Pop-Location }
    if ($exitCode -eq 0) {
      $resultLog = Get-Content -Path $evidenceLog -Raw
      if ($resultLog -notmatch 'QA REHEARSAL PASS:' -or
          $resultLog -notmatch 'CLEANUP: Q3-[1-3] AVAILABLE; order [0-9a-f-]+ CLOSED') {
        '[QA3] INCONCLUSIVE: runner did not report both business state and own cleanup' |
          Tee-Object -FilePath $evidenceLog -Append
        $exitCode = 2
      }
    }
  }
  $after = (Invoke-RestMethod -Method Get -Uri "$base/version" -TimeoutSec 20).commit
  if ($after -ne $before) {
    '[QA3] INCONCLUSIVE: staging build changed during run' |
      Tee-Object -FilePath $evidenceLog -Append
    $exitCode = 1
  }
} finally {
  Remove-Item Env:BASE_URL, Env:S2_STAGING_PIN, Env:QA3_REHEARSAL, Env:QA_UI_EVIDENCE_DIR -ErrorAction SilentlyContinue
  $pin = $null
  $credential = $null
  $headers = $null
  $auth = $null
}

Write-Host "QA 3 rehearsal evidence: $evidenceLog"
if (Test-Path $imageDir) { Write-Host "QA 3 UI image/video evidence: $imageDir" }
Write-Host '[QA3] One QA operating three seed roles is rehearsal; do not count as four-person UAT.'
if ($exitCode -eq 1) { Write-Warning 'Check CLEANUP REQUIRED in the log before any rerun.' }
exit $exitCode
