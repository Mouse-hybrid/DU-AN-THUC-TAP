param([string]$BaseUrl = 'http://160.191.47.17')

$ErrorActionPreference = 'Stop'
$exitCode = 1
$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\DES-QA-06'
$evidenceLog = Join-Path $evidenceDir ("BVA_COMPONENT_001_009_{0}.log" -f (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
$testScript = Join-Path $PSScriptRoot 'des06_verify_sla_bva.py'
$pyLauncher = Get-Command py -ErrorAction SilentlyContinue
$python = Get-Command python -ErrorAction SilentlyContinue

if (-not $pyLauncher -and -not $python) {
  throw 'Python 3.10+ is required to execute the backend compute_sla function'
}

New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
  $previousConsole = [Console]::OutputEncoding
  $previousOutput = $OutputEncoding
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $OutputEncoding = [Console]::OutputEncoding
  try {
    if ($pyLauncher) {
      & py -3 $testScript --base-url $BaseUrl 2>&1 | Tee-Object -FilePath $evidenceLog
    } else {
      & python $testScript --base-url $BaseUrl 2>&1 | Tee-Object -FilePath $evidenceLog
    }
    $exitCode = $LASTEXITCODE
  } finally {
    [Console]::OutputEncoding = $previousConsole
    $OutputEncoding = $previousOutput
  }
} finally { Pop-Location }

Write-Host "DES-QA-06 Component evidence: $evidenceLog"
exit $exitCode
