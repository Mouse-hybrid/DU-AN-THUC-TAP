param(
  [string]$BaseUrl = 'http://160.191.47.17',
  [string]$ExpectedCommit = '972b942'
)

$ErrorActionPreference = 'Stop'
$exitCode = 1
$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\EXE-QA-04'
$evidenceLog = Join-Path $evidenceDir ("READONLY_SMOKE_{0}.log" -f (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
$credential = $null
$seedPassword = $null

try {
  $origin = $BaseUrl.TrimEnd('/')
  $version = Invoke-RestMethod -Uri "$origin/version" -Method Get -TimeoutSec 20
  $commit = [string]$version.commit
  if (-not $commit) { throw 'Staging /version did not include a commit' }
  if ($ExpectedCommit -and -not $commit.StartsWith($ExpectedCommit, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Staging commit $commit differs from expected $ExpectedCommit. Confirm the build before this smoke run."
  }

  $credential = Get-Credential -UserName 'kitchen' -Message 'Shared staging PIN for Kitchen and Supervisor smoke'
  if (-not $credential) { throw 'Credential prompt cancelled' }
  $seedPassword = $credential.GetNetworkCredential().Password
  if (-not $seedPassword) { throw 'Staging PIN is empty' }

  New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
  "[EXE-QA-04] Read-only smoke staging $commit; POST only for JWT login" |
    Tee-Object -FilePath $evidenceLog
  $env:CYPRESS_POS_BASE_URL = $origin
  $env:CYPRESS_EXE04_EXPECTED_COMMIT = $ExpectedCommit
  $env:CYPRESS_EXE04_SEED_PASSWORD = $seedPassword

  Push-Location (Split-Path -Parent $PSScriptRoot)
  try {
    $priorConsoleEncoding = [Console]::OutputEncoding
    $priorOutputEncoding = $OutputEncoding
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Console]::OutputEncoding
    try {
      & npx cypress run --browser chrome --headless --spec 'cypress/e2e/exe_qa_04/exe_qa_04_readonly_smoke.cy.js' 2>&1 |
        Tee-Object -FilePath $evidenceLog -Append
      $exitCode = $LASTEXITCODE
    } finally {
      [Console]::OutputEncoding = $priorConsoleEncoding
      $OutputEncoding = $priorOutputEncoding
    }
  } finally {
    Pop-Location
  }
} finally {
  'CYPRESS_POS_BASE_URL', 'CYPRESS_EXE04_EXPECTED_COMMIT', 'CYPRESS_EXE04_SEED_PASSWORD' |
    ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }
  $seedPassword = $null
  $credential = $null
}

Write-Host "EXE-QA-04 Terminal evidence: $evidenceLog"
exit $exitCode
