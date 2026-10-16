param(
  [string]$BaseUrl = 'http://160.191.47.17',
  [string]$OutletAUser = '',
  [string]$OutletBUser = '',
  [string]$OutletBOrderId = ''
)

$ErrorActionPreference = 'Stop'
$base = $BaseUrl.TrimEnd('/')
if ($base -ne 'http://160.191.47.17') { throw 'TC_EXT_019 is restricted to approved staging' }
if ([string]::IsNullOrWhiteSpace($OutletAUser) -or
    [string]::IsNullOrWhiteSpace($OutletBUser) -or
    $OutletAUser -match '^<.*>$' -or
    $OutletBUser -match '^<.*>$' -or
    $OutletBOrderId -notmatch '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$') {
  Write-Host '[Phase 1] TC_EXT_019 BLOCKED: supply real QA usernames from two different outlets and a QA order UUID belonging to outlet B.'
  Write-Host '[Phase 1] Placeholder values are examples. No login or business GET executed; no evidence log created.'
  return
}
$evidenceDir = Join-Path $PSScriptRoot '..\..\..\..\evidence\AFG_POS'
$evidenceLog = Join-Path $evidenceDir ("TC_EXT_019_CROSS_OUTLET_{0}.log" -f (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
$aCredential = $null
$bCredential = $null
$aPassword = $null
$bPassword = $null
$exitCode = 1

try {
  $aCredential = Get-Credential -UserName $OutletAUser -Message 'Outlet A QA account PIN'
  $bCredential = Get-Credential -UserName $OutletBUser -Message 'Outlet B QA account PIN'
  if (-not $aCredential -or -not $bCredential) { throw 'Credential prompt cancelled' }
  $aPassword = $aCredential.GetNetworkCredential().Password
  $bPassword = $bCredential.GetNetworkCredential().Password
  if (-not $aPassword -or -not $bPassword) { throw 'QA PIN cannot be empty' }
  New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
  $before = (Invoke-RestMethod -Method Get -Uri "$base/version" -TimeoutSec 20).commit
  if ($before -notmatch '^[0-9a-f]{40}$') { throw 'GET /version missing full commit' }
  "[Phase 1] TC_EXT_019 staging start $($before.Substring(0, 12)); read-only cross-outlet QA order" |
    Tee-Object -FilePath $evidenceLog

  $env:CYPRESS_POS_BASE_URL = $base
  $env:CYPRESS_PHASE1_OUTLET_A_USERNAME = $OutletAUser
  $env:CYPRESS_PHASE1_OUTLET_A_PASSWORD = $aPassword
  $env:CYPRESS_PHASE1_OUTLET_B_USERNAME = $OutletBUser
  $env:CYPRESS_PHASE1_OUTLET_B_PASSWORD = $bPassword
  $env:CYPRESS_PHASE1_OUTLET_B_ORDER_ID = $OutletBOrderId
  Push-Location (Split-Path -Parent $PSScriptRoot)
  try {
    $priorConsole = [Console]::OutputEncoding
    $priorOutput = $OutputEncoding
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Console]::OutputEncoding
    try {
      & npx cypress run --browser chrome --headless --spec 'cypress/e2e/tc_ext/tc_ext_019_cross_outlet_readonly.cy.js' 2>&1 |
        Tee-Object -FilePath $evidenceLog -Append
      $exitCode = $LASTEXITCODE
    } finally {
      [Console]::OutputEncoding = $priorConsole
      $OutputEncoding = $priorOutput
    }
  } finally { Pop-Location }

  $after = (Invoke-RestMethod -Method Get -Uri "$base/version" -TimeoutSec 20).commit
  if ($after -ne $before) {
    '[Phase 1] TC_EXT_019 INCONCLUSIVE: staging changed during run' |
      Tee-Object -FilePath $evidenceLog -Append
    $exitCode = 1
  }
} finally {
  Remove-Item Env:CYPRESS_POS_BASE_URL, Env:CYPRESS_PHASE1_OUTLET_A_USERNAME, Env:CYPRESS_PHASE1_OUTLET_A_PASSWORD, Env:CYPRESS_PHASE1_OUTLET_B_USERNAME, Env:CYPRESS_PHASE1_OUTLET_B_PASSWORD, Env:CYPRESS_PHASE1_OUTLET_B_ORDER_ID -ErrorAction SilentlyContinue
  $aPassword = $null
  $bPassword = $null
  $aCredential = $null
  $bCredential = $null
}

Write-Host "Phase 1 Terminal evidence: $evidenceLog"
Write-Host '[Phase 1] No order or table changed.'
exit $exitCode
