param([string]$BaseUrl = 'http://160.191.47.17')

$ErrorActionPreference = 'Stop'
$base = $BaseUrl.TrimEnd('/')
if ($base -ne 'http://160.191.47.17') { throw 'TC_API_12_001 is restricted to approved staging' }
$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\AFG_POS'
$evidenceLog = Join-Path $evidenceDir ("TC_API_12_001_START_COOKING_{0}.log" -f (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
$credential = $null
$exitCode = 1

try {
  $credential = Get-Credential -UserName 'waiter' -Message 'Shared staging PIN for isolated Start Cooking and cleanup'
  if (-not $credential) { throw 'Credential prompt cancelled' }
  if (-not $credential.GetNetworkCredential().Password) { throw 'Staging PIN is empty' }

  New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
  $before = (Invoke-RestMethod -Method Get -Uri "$base/version" -TimeoutSec 20).commit
  if ($before -notmatch '^[0-9a-f]{40}$') { throw 'GET /version missing full commit' }
  "[Phase 1] TC_API_12_001 staging start $($before.Substring(0, 12)); SENT -> PREPARING, no ACCEPTED step" |
    Tee-Object -FilePath $evidenceLog

  $env:CYPRESS_POS_BASE_URL = $base
  $env:CYPRESS_DES05_SEED_PASSWORD = $credential.GetNetworkCredential().Password
  Push-Location (Split-Path -Parent $PSScriptRoot)
  try {
    $priorConsole = [Console]::OutputEncoding
    $priorOutput = $OutputEncoding
    $priorErrorActionPreference = $ErrorActionPreference
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Console]::OutputEncoding
    try {
      $ErrorActionPreference = 'Continue'
      & npx cypress run --browser chrome --headless --expose 'TC_API_12_001_ONLY=true' --spec 'cypress/e2e/des_qa_05/des_qa_05_lifecycle_isolated.cy.js' 2>&1 |
        Tee-Object -FilePath $evidenceLog -Append
      $exitCode = $LASTEXITCODE
      if ($exitCode -eq 0) {
        $evidence = Get-Content -Path $evidenceLog -Raw
        if (-not ($evidence.Contains('TC_API_12_001 assertions OK') -and
                   $evidence.Contains('DES05 lifecycle cleanup:'))) {
          '[Phase 1] TC_API_12_001 PENDING: business assertions or cleanup absent from evidence' |
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
    '[Phase 1] TC_API_12_001 INCONCLUSIVE: staging changed during run' |
      Tee-Object -FilePath $evidenceLog -Append
    $exitCode = 1
  }
} finally {
  Remove-Item Env:CYPRESS_POS_BASE_URL, Env:CYPRESS_DES05_SEED_PASSWORD -ErrorAction SilentlyContinue
  $credential = $null
}

Write-Host "Phase 1 Terminal evidence: $evidenceLog"
if ($exitCode -ne 0) { Write-Warning 'Check CLEANUP REQUIRED in the log before rerunning.' }
exit $exitCode
