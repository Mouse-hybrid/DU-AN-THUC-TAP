param(
  [string]$BaseUrl = 'http://160.191.47.17',
  [string]$ExpectedCommit = ''
)

$ErrorActionPreference = 'Stop'
$base = $BaseUrl.TrimEnd('/')
if ($base -ne 'http://160.191.47.17') { throw 'EXE-QA-04 live smoke is restricted to approved staging' }
$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\EXE-QA-04'
$evidenceLog = Join-Path $evidenceDir ("LIVE_KDS_SMOKE_{0}.log" -f (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
$credential = $null
$exitCode = 1

try {
  $before = [string](Invoke-RestMethod -Method Get -Uri "$base/version" -TimeoutSec 20).commit
  if ($before -notmatch '^[0-9a-f]{40}$') { throw 'GET /version missing full commit' }
  if ($ExpectedCommit -and -not $before.StartsWith($ExpectedCommit, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Staging commit $before differs from expected $ExpectedCommit"
  }
  $credential = Get-Credential -UserName 'waiter' -Message 'Shared staging PIN for isolated EXE-QA-04 live smoke and cleanup'
  if (-not $credential) { throw 'Credential prompt cancelled' }
  if (-not $credential.GetNetworkCredential().Password) { throw 'Staging PIN is empty' }

  New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
  "[EXE-QA-04] Live smoke staging $before; own B1-B4 order/item, Kitchen Queue and WS event, cleanup" |
    Tee-Object -FilePath $evidenceLog
  $env:CYPRESS_POS_BASE_URL = $base
  $env:CYPRESS_DES05_SEED_PASSWORD = $credential.GetNetworkCredential().Password
  $env:CYPRESS_EXE04_LIVE_SMOKE_ONLY = 'true'

  Push-Location (Split-Path -Parent $PSScriptRoot)
  try {
    $priorConsole = [Console]::OutputEncoding
    $priorOutput = $OutputEncoding
    $priorErrorActionPreference = $ErrorActionPreference
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Console]::OutputEncoding
    try {
      $ErrorActionPreference = 'Continue'
      & npx cypress run --browser chrome --headless --spec 'cypress/e2e/tc_ext/tc_ext_016_017_ws_isolated.cy.js' 2>&1 |
        Tee-Object -FilePath $evidenceLog -Append
      $exitCode = $LASTEXITCODE
      if ($exitCode -eq 0) {
        $evidence = Get-Content -Path $evidenceLog -Raw
        if (-not ($evidence.Contains('EXE-QA-04 live smoke / TC_EXT_016 assertions OK') -and
                   $evidence.Contains('WS cleanup:'))) {
          '[EXE-QA-04] PENDING: live Kitchen assertions or cleanup absent from evidence' |
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

  $after = [string](Invoke-RestMethod -Method Get -Uri "$base/version" -TimeoutSec 20).commit
  if ($after -ne $before) {
    '[EXE-QA-04] INCONCLUSIVE: staging changed during live smoke' |
      Tee-Object -FilePath $evidenceLog -Append
    $exitCode = 1
  }
} finally {
  Remove-Item Env:CYPRESS_POS_BASE_URL, Env:CYPRESS_DES05_SEED_PASSWORD, Env:CYPRESS_EXE04_LIVE_SMOKE_ONLY -ErrorAction SilentlyContinue
  $credential = $null
}

Write-Host "EXE-QA-04 Terminal evidence: $evidenceLog"
if ($exitCode -ne 0) { Write-Warning 'Check CLEANUP REQUIRED in the log before rerunning.' }
exit $exitCode
