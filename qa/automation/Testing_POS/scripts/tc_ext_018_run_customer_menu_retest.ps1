param([string]$BaseUrl = 'http://160.191.47.17')

$ErrorActionPreference = 'Stop'
$base = $BaseUrl.TrimEnd('/')
if ($base -ne 'http://160.191.47.17') { throw 'TC_EXT_018 is restricted to approved staging' }
$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\AFG_POS'
$evidenceLog = Join-Path $evidenceDir ("TC_EXT_018_CUSTOMER_UI_RETEST_{0}.log" -f (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
$exitCode = 1

New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
$before = (Invoke-RestMethod -Method Get -Uri "$base/version" -TimeoutSec 20).commit
if ($before -notmatch '^[0-9a-f]{40}$') { throw 'GET /version missing full commit' }
"[Phase 1] TC_EXT_018 staging start $($before.Substring(0, 12)); read-only Customer UI retest" |
  Tee-Object -FilePath $evidenceLog

try {
  $env:BASE_URL = $base
  $env:CUSTOMER_MENU_URL = "$base/customer"
  Push-Location (Split-Path -Parent $PSScriptRoot)
  try {
    $priorConsole = [Console]::OutputEncoding
    $priorOutput = $OutputEncoding
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Console]::OutputEncoding
    try {
      & npx playwright test test_playwright_version/tc_ext_018_route_diagnostics.spec.ts test_playwright_version/tc_ext_018_customer_menu.spec.ts --project=chromium --workers=1 --timeout=25000 2>&1 |
        Tee-Object -FilePath $evidenceLog -Append
      $exitCode = $LASTEXITCODE
    } finally {
      [Console]::OutputEncoding = $priorConsole
      $OutputEncoding = $priorOutput
    }
  } finally { Pop-Location }

  $after = (Invoke-RestMethod -Method Get -Uri "$base/version" -TimeoutSec 20).commit
  if ($after -ne $before) {
    '[Phase 1] TC_EXT_018 INCONCLUSIVE: staging changed during run' |
      Tee-Object -FilePath $evidenceLog -Append
    $exitCode = 1
  }
} finally {
  Remove-Item Env:BASE_URL, Env:CUSTOMER_MENU_URL -ErrorAction SilentlyContinue
}

Write-Host "Phase 1 Terminal evidence: $evidenceLog"
Write-Host '[Phase 1] Diagnostics are not a business PASS; check TC_EXT_018 test result and the final route.'
exit $exitCode
