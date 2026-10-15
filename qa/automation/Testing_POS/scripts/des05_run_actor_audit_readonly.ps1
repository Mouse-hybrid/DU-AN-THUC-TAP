param(
  [string]$BaseUrl = 'http://160.191.47.17',
  [string]$ExpectedCommit = 'd466a3d',
  [switch]$LatestRegression
)

$ErrorActionPreference = 'Stop'
$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\DES-QA-05'
New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
$evidencePrefix = if ($LatestRegression) { 'AUDIT_REGRESSION_TC-012_019' } else { 'AUDIT_TC-012_019' }
$evidenceLog = Join-Path $evidenceDir ("{0}_{1}.log" -f $evidencePrefix, (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
$exitCode = 1
$credential = $null

try {
  if ($LatestRegression) {
    $lifecycleLog = Get-ChildItem -Path $evidenceDir -Filter 'TC-012_013_014_015_*.log' |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    $refireLog = Get-ChildItem -Path $evidenceDir -Filter 'TC-019_to_024_*.log' |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $lifecycleLog -or -not $refireLog -or
        $lifecycleLog.LastWriteTime.Date -ne (Get-Date).Date -or
        $refireLog.LastWriteTime.Date -ne (Get-Date).Date) {
      throw 'LatestRegression requires both TC-012..015 and TC-019..024 evidence logs from today.'
    }
    $uuid = '[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}'
    $startMatch = [regex]::Match((Get-Content $lifecycleLog.FullName -Raw -Encoding UTF8),
      "DES05-TC-012 API assertions OK:[^`r`n]*?order (?<order>$uuid); item (?<item>$uuid)")
    $refireMatch = [regex]::Match((Get-Content $refireLog.FullName -Raw -Encoding UTF8),
      "DES05-TC-019 API assertions OK[^`r`n]*?order (?<order>$uuid); item (?<item>$uuid);[^`r`n]*?version [0-9]+ -> (?<version>[0-9]+)")
    if (-not $startMatch.Success -or -not $refireMatch.Success) {
      throw 'Could not find successful TC-012 and TC-019 assertion lines in the latest logs; no audit executed.'
    }

    $version = Invoke-RestMethod -Uri ($BaseUrl.TrimEnd('/') + '/version') -TimeoutSec 10
    $stagingCommit = [string]$version.commit
    if (-not $stagingCommit) { $stagingCommit = [string]$version.short_commit }
    if (-not $stagingCommit) { throw 'GET /version did not return a staging commit.' }
    if (-not $stagingCommit.StartsWith($ExpectedCommit, [StringComparison]::OrdinalIgnoreCase)) {
      $compareUrl = "https://api.github.com/repos/Mouse-hybrid/DU-AN-THUC-TAP/compare/${ExpectedCommit}...${stagingCommit}"
      try {
        $comparison = Invoke-RestMethod -Uri $compareUrl -Headers @{ 'User-Agent' = 'DES-QA-05-QA' } -TimeoutSec 15
      } catch {
        throw "Cannot verify that staging $stagingCommit includes audit API baseline $ExpectedCommit; no audit executed."
      }
      if ($comparison.status -notin @('ahead', 'identical')) {
        throw "Staging $stagingCommit does not descend from audit API baseline $ExpectedCommit; no audit executed."
      }
    }
    $ExpectedCommit = $stagingCommit
    $env:CYPRESS_DES05_AUDIT_START_ORDER_ID = $startMatch.Groups['order'].Value
    $env:CYPRESS_DES05_AUDIT_START_ITEM_ID = $startMatch.Groups['item'].Value
    $env:CYPRESS_DES05_AUDIT_REFIRE_ORDER_ID = $refireMatch.Groups['order'].Value
    $env:CYPRESS_DES05_AUDIT_REFIRE_ITEM_ID = $refireMatch.Groups['item'].Value
    $env:CYPRESS_DES05_AUDIT_REFIRE_VERSION = $refireMatch.Groups['version'].Value
    "[DES-QA-05] Regression audit sources: $($lifecycleLog.Name); $($refireLog.Name); staging $stagingCommit" |
      Tee-Object -FilePath $evidenceLog
  }

  $credential = Get-Credential -UserName 'admin' -Message 'Staging Supervisor/admin credential for read-only audit evidence'
  $env:CYPRESS_POS_BASE_URL = $BaseUrl
  $env:CYPRESS_DES05_EXPECTED_COMMIT = $ExpectedCommit
  $env:CYPRESS_DES05_AUDIT_PASSWORD = $credential.GetNetworkCredential().Password
  Push-Location (Split-Path -Parent $PSScriptRoot)
  try {
    $previousConsole = [Console]::OutputEncoding
    $previousOutput = $OutputEncoding
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Console]::OutputEncoding
    try {
      & npx cypress run --browser chrome --headless --spec 'cypress/e2e/des_qa_05/des_qa_05_actor_audit_readonly.cy.js' 2>&1 |
        Tee-Object -FilePath $evidenceLog -Append
      $exitCode = $LASTEXITCODE
    } finally {
      [Console]::OutputEncoding = $previousConsole
      $OutputEncoding = $previousOutput
    }
  } finally { Pop-Location }
} finally {
  'CYPRESS_POS_BASE_URL', 'CYPRESS_DES05_EXPECTED_COMMIT', 'CYPRESS_DES05_AUDIT_PASSWORD',
  'CYPRESS_DES05_AUDIT_START_ORDER_ID', 'CYPRESS_DES05_AUDIT_START_ITEM_ID',
  'CYPRESS_DES05_AUDIT_REFIRE_ORDER_ID', 'CYPRESS_DES05_AUDIT_REFIRE_ITEM_ID',
  'CYPRESS_DES05_AUDIT_REFIRE_VERSION' |
    ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }
  $credential = $null
}

Write-Host "DES-QA-05 Actor audit evidence: $evidenceLog"
exit $exitCode
