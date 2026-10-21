param([string]$BaseUrl = 'http://160.191.47.17')

$ErrorActionPreference = 'Stop'
$base = $BaseUrl.TrimEnd('/')
if ($base -ne 'http://160.191.47.17') { throw 'PF-UI-010 is restricted to approved staging' }
$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\DES-QA-06'
$evidenceLog = Join-Path $evidenceDir ("PF_UI_010_KDS_{0}.log" -f (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
$credential = Get-Credential -UserName 'kitchen' -Message 'Shared staging PIN for read-only Kitchen UI inspection'
$exitCode = 1

try {
  if (-not $credential) { throw 'Credential prompt cancelled' }
  $pin = $credential.GetNetworkCredential().Password
  if (-not $pin) { throw 'Staging PIN is empty' }
  New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
  $before = (Invoke-RestMethod -Method Get -Uri "$base/version" -TimeoutSec 20).commit
  if ($before -notmatch '^[0-9a-f]{40}$') { throw 'GET /version missing full commit' }
  "[TSK-QA-010] PF-UI-010 staging start $($before.Substring(0, 12)); read-only UI and REST" |
    Tee-Object -FilePath $evidenceLog

  $env:BASE_URL = $base
  $env:KDS_STAGING_PIN = $pin
  Push-Location (Split-Path -Parent $PSScriptRoot)
  try {
    $priorConsole = [Console]::OutputEncoding
    $priorOutput = $OutputEncoding
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Console]::OutputEncoding
    try {
      & npx playwright test test_playwright_version/tsk_qa_010_kds_ui_readonly.spec.ts --project=chromium 2>&1 |
        Tee-Object -FilePath $evidenceLog -Append
      $exitCode = $LASTEXITCODE
    } finally {
      [Console]::OutputEncoding = $priorConsole
      $OutputEncoding = $priorOutput
    }
  } finally { Pop-Location }

  $after = (Invoke-RestMethod -Method Get -Uri "$base/version" -TimeoutSec 20).commit
  if ($after -ne $before) {
    '[TSK-QA-010] INCONCLUSIVE: staging changed during run' |
      Tee-Object -FilePath $evidenceLog -Append
    $exitCode = 1
  }
} finally {
  Remove-Item Env:BASE_URL, Env:KDS_STAGING_PIN -ErrorAction SilentlyContinue
  $pin = $null
  $credential = $null
}

Write-Host "TSK-QA-010 Terminal evidence: $evidenceLog"
Write-Host '[TSK-QA-010] PF-UI-010 is component readiness only; TSK-QA-010 and TC_EXT_017 remain open.'
exit $exitCode
