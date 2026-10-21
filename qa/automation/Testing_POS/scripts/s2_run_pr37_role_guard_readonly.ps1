param([string]$BaseUrl = 'http://160.191.47.17')

$ErrorActionPreference = 'Stop'
$base = $BaseUrl.TrimEnd('/')
if ($base -ne 'http://160.191.47.17') { throw 'S2 role UI readiness is restricted to approved staging' }
$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\EXE-QA-04'
$evidenceLog = Join-Path $evidenceDir ("S2_PR37_ROLE_UI_READONLY_{0}.log" -f (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
$credential = Get-Credential -UserName 'admin' -Message 'Shared staging PIN for four read-only role UI checks'
if (-not $credential) { throw 'Credential prompt cancelled' }
$pin = $credential.GetNetworkCredential().Password
if (-not $pin) { throw 'Staging PIN is empty' }

New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
$before = (Invoke-RestMethod -Method Get -Uri "$base/version" -TimeoutSec 20).commit
if ($before -notmatch '^[0-9a-f]{40}$') { throw 'GET /version missing full commit' }
"[S2-UI] PR37 role/read-only start $($before.Substring(0, 12)); four roles, no business mutation" |
  Tee-Object -FilePath $evidenceLog
$exitCode = 1
try {
  $env:BASE_URL = $base
  $env:S2_STAGING_PIN = $pin
  Push-Location (Split-Path -Parent $PSScriptRoot)
  try {
    $priorConsole = [Console]::OutputEncoding
    $priorOutput = $OutputEncoding
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Console]::OutputEncoding
    try {
      & npx playwright test test_playwright_version/s2_pr37_role_guard_readonly.spec.ts --project=chromium 2>&1 |
        Tee-Object -FilePath $evidenceLog -Append
      $exitCode = $LASTEXITCODE
    } finally {
      [Console]::OutputEncoding = $priorConsole
      $OutputEncoding = $priorOutput
    }
  } finally { Pop-Location }

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
Write-Host '[S2-UI] Route/readiness assertions are not business lifecycle PASS.'
exit $exitCode
