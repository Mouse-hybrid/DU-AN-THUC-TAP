param([string]$BaseUrl = 'http://160.191.47.17')

$ErrorActionPreference = 'Stop'
$base = $BaseUrl.TrimEnd('/')
if ($base -ne 'http://160.191.47.17') { throw 'TC_PM_35 is restricted to approved staging' }
$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\AFG_POS'
$evidenceLog = Join-Path $evidenceDir ("TC_PM_35_WAITER_PATCH_{0}.log" -f (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
$credential = $null
$seedPassword = $null
$exitCode = 1

try {
  $credential = Get-Credential -UserName 'admin' -Message 'Shared staging PIN for isolated Waiter PATCH and cleanup'
  if (-not $credential) { throw 'Credential prompt cancelled' }
  $seedPassword = $credential.GetNetworkCredential().Password
  if (-not $seedPassword) { throw 'Staging PIN is empty' }

  New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
  $before = (Invoke-RestMethod -Method Get -Uri "$base/version" -TimeoutSec 20).commit
  if ($before -notmatch '^[0-9a-f]{40}$') { throw 'GET /version missing full commit' }
  "[Phase 1] TC_PM_35 staging start $($before.Substring(0, 12))" |
    Tee-Object -FilePath $evidenceLog

  Write-Host '[Phase 1] TC_PM_35 approved expected: Waiter CREATED PATCH 200; SENT PATCH 409 and no mutation.'
  $env:CYPRESS_POS_BASE_URL = $base
  $env:CYPRESS_DES05_SEED_PASSWORD = $seedPassword
  Push-Location (Split-Path -Parent $PSScriptRoot)
  try {
    $priorConsole = [Console]::OutputEncoding
    $priorOutput = $OutputEncoding
    $priorErrorActionPreference = $ErrorActionPreference
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Console]::OutputEncoding
    try {
      $ErrorActionPreference = 'Continue'
      & npx cypress run --browser chrome --headless --spec 'cypress/e2e/tc_ext/tc_pm_35_waiter_patch_current_contract.cy.js' 2>&1 |
        Tee-Object -FilePath $evidenceLog -Append
      $exitCode = $LASTEXITCODE
      if ($exitCode -eq 0) {
        $evidence = Get-Content -Path $evidenceLog -Raw
        if (-not ($evidence.Contains('TC_PM_35 CREATED PASS') -and
                   $evidence.Contains('TC_PM_35 SENT PASS') -and
                   $evidence.Contains('TC_PM_35 cleanup:'))) {
          '[Phase 1] TC_PM_35 PENDING: business assertions or cleanup absent from evidence' |
            Tee-Object -FilePath $evidenceLog -Append
          $exitCode = 2
        }
      }
    } finally {
      $ErrorActionPreference = $priorErrorActionPreference
      [Console]::OutputEncoding = $priorConsole
      $OutputEncoding = $priorOutput
    }
  } finally { Pop-Location }

  $after = (Invoke-RestMethod -Method Get -Uri "$base/version" -TimeoutSec 20).commit
  if ($after -ne $before) {
    "[Phase 1] TC_PM_35 INCONCLUSIVE: staging changed during run" |
      Tee-Object -FilePath $evidenceLog -Append
    $exitCode = 1
  }
} finally {
  Remove-Item Env:CYPRESS_POS_BASE_URL, Env:CYPRESS_DES05_SEED_PASSWORD -ErrorAction SilentlyContinue
  $seedPassword = $null
  $credential = $null
}

Write-Host "Phase 1 Terminal evidence: $evidenceLog"
if ($exitCode -ne 0) { Write-Warning 'Check CLEANUP REQUIRED in the log before rerunning.' }
exit $exitCode
