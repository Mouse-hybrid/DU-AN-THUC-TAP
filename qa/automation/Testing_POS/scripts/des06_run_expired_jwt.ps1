param([string]$BaseUrl = 'http://160.191.47.17')

$ErrorActionPreference = 'Stop'
$exitCode = 1
$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\DES-QA-06'
$evidenceLog = Join-Path $evidenceDir ("TC-033_EXPIRED_JWT_{0}.log" -f (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
$credential = $null
$seedPassword = $null

try {
  $credential = Get-Credential -UserName 'admin' -Message 'Staging Supervisor PIN for the overnight expired-JWT test'
  if (-not $credential) { throw 'Credential prompt cancelled' }
  $seedPassword = $credential.GetNetworkCredential().Password
  if (-not $seedPassword) { throw 'Staging PIN is empty' }

  $env:POS_BASE_URL = $BaseUrl.TrimEnd('/')
  $env:DES06_SEED_PASSWORD = $seedPassword
  New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
  Push-Location (Split-Path -Parent $PSScriptRoot)
  try {
    $previousConsole = [Console]::OutputEncoding
    $previousOutput = $OutputEncoding
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Console]::OutputEncoding
    try {
      & node '.\scripts\des06_verify_expired_jwt.mjs' 2>&1 | Tee-Object -FilePath $evidenceLog
      $exitCode = $LASTEXITCODE
    } finally {
      [Console]::OutputEncoding = $previousConsole
      $OutputEncoding = $previousOutput
    }
  } finally { Pop-Location }
} finally {
  Remove-Item Env:POS_BASE_URL, Env:DES06_SEED_PASSWORD -ErrorAction SilentlyContinue
  $seedPassword = $null
  $credential = $null
}

Write-Host "DES-QA-06 Terminal evidence: $evidenceLog"
exit $exitCode
