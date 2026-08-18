<#
.SYNOPSIS
  One-command deployment of the Azure STIG Dashboard.

.DESCRIPTION
  The "easiest path" for an entry-level admin. Asks four questions, then:

    1. Verifies az CLI and azd are installed and signed in.
    2. Creates / updates the Entra app registration (delegates to
       scripts/create-app-registration.ps1).
    3. Runs `azd up` to provision and deploy everything.
    4. Runs scripts/post-deploy.ps1 to grant subscription-scope Reader +
       Security Reader to the backend MI and the operator app-role to the
       Function MI.

  Re-running the script is safe — every step is idempotent.

.PARAMETER OrgName
  Resource prefix. 3–14 lowercase letters / digits.

.PARAMETER Location
  Azure region (e.g. eastus, usgovvirginia).

.PARAMETER EnvName
  azd environment name. Default: prod.

.PARAMETER CloudEnvironment
  AzureCloud | AzureUSGovernment | AzureUSGovernmentDoD.

.EXAMPLE
  ./scripts/deploy.ps1
  # Interactive — prompts for everything.

.EXAMPLE
  ./scripts/deploy.ps1 -OrgName contoso -Location eastus
#>
[CmdletBinding()]
param(
  [string]$OrgName,
  [string]$Location,
  [string]$EnvName          = 'prod',
  [ValidateSet('AzureCloud','AzureUSGovernment','AzureUSGovernmentDoD')]
  [string]$CloudEnvironment = 'AzureCloud',
  [string]$AppServiceSku    = 'B1',
  [int]$TrackedHostCount    = 25,
  [bool]$AutoSizeByTrackedHosts = $true,
  [bool]$EnableScheduler    = $true,
  [bool]$EnableDiagnostics  = $true,
  [bool]$BusinessHoursMode  = $false,
  [string]$BusinessHoursTimeZone = 'UTC',
  [ValidateRange(0,23)]
  [int]$BusinessHoursStartHour = 8,
  [ValidateRange(0,23)]
  [int]$BusinessHoursEndHour = 18,
  [bool]$AutoShutdownOutsideBusinessHours = $false
)

$ErrorActionPreference = 'Stop'

function Read-Required([string]$Prompt, [string]$Default = $null, [string]$Pattern = $null) {
  while ($true) {
    $hint = if ($Default) { " [$Default]" } else { '' }
    $value = Read-Host "$Prompt$hint"
    if (-not $value -and $Default) { $value = $Default }
    if (-not $value) { Write-Host 'Required.' -ForegroundColor Yellow; continue }
    if ($Pattern -and ($value -notmatch $Pattern)) { Write-Host "Value must match: $Pattern" -ForegroundColor Yellow; continue }
    return $value
  }
}

function Test-Cmd([string]$Name) {
  $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

# ── 1. Tooling check ─────────────────────────────────────────────────────────
Write-Host ''
Write-Host '═══ Azure STIG Dashboard — one-command deploy ═══════════════════'
Write-Host ''
if (-not (Test-Cmd az))  { Write-Error "Azure CLI not found. Install: https://aka.ms/installazurecli"; exit 1 }
if (-not (Test-Cmd azd)) { Write-Error "Azure Developer CLI not found. Install: https://aka.ms/install-azd"; exit 1 }

$account = az account show --only-show-errors -o json 2>$null | ConvertFrom-Json
if (-not $account) {
  Write-Host 'Not signed in to az. Launching device-code login...'
  az login --use-device-code | Out-Null
  $account = az account show -o json | ConvertFrom-Json
}
Write-Host "Signed in as $($account.user.name) (subscription: $($account.name))."
Write-Host ''

# ── 2. Gather inputs ─────────────────────────────────────────────────────────
if (-not $OrgName)  { $OrgName  = Read-Required 'Organization name (3-14 lowercase letters/digits)' 'stigdash' '^[a-z][a-z0-9]{2,13}$' }
if (-not $Location) { $Location = Read-Required 'Azure region (e.g. eastus, usgovvirginia)' 'eastus' }

# Database password — generated, never typed. Stored in azd env (encrypted).
$dbPassword = -join ((65..90) + (97..122) + (48..57) + (33,35,36,37,38,42) | Get-Random -Count 24 | ForEach-Object {[char]$_})
# Force at least one of each required class so the bicep validator is happy.
$dbPassword = "Aa1!$dbPassword"
Write-Host "Generated PostgreSQL admin password (saved to azd env, never displayed)."
Write-Host ''

# ── 3. Create / refresh the Entra app registration ───────────────────────────
Write-Host '─── Step 1/3 — Microsoft Entra app registration ─────────────────'
$reg = & "$PSScriptRoot/create-app-registration.ps1" -OrgName $OrgName -CloudEnvironment $CloudEnvironment
if (-not $reg -or -not $reg.clientId) { Write-Error 'App-registration bootstrap failed.'; exit 1 }
Write-Host ''

# ── 4. azd env + deploy ──────────────────────────────────────────────────────
Write-Host '─── Step 2/3 — azd up ────────────────────────────────────────────'
$envList = azd env list -o json 2>$null | ConvertFrom-Json
if (-not ($envList | Where-Object { $_.Name -eq $EnvName })) {
  azd env new $EnvName --location $Location --subscription $account.id | Out-Null
} else {
  azd env select $EnvName | Out-Null
}

azd env set AZURE_LOCATION       $Location           | Out-Null
azd env set AZURE_TENANT_ID      $reg.tenantId       | Out-Null
azd env set AZURE_CLIENT_ID      $reg.clientId       | Out-Null
azd env set AZURE_CLIENT_SECRET  $reg.clientSecret   | Out-Null
azd env set DB_ADMIN_PASSWORD    $dbPassword         | Out-Null
azd env set MOCK_MODE            'false'             | Out-Null
azd env set APP_SERVICE_SKU      $AppServiceSku      | Out-Null
azd env set AUTO_SIZE_BY_TRACKED_HOSTS ($AutoSizeByTrackedHosts.ToString().ToLowerInvariant()) | Out-Null
azd env set TRACKED_HOST_COUNT   $TrackedHostCount   | Out-Null
azd env set ORG_NAME             $OrgName            | Out-Null
# Must match the hostname create-app-registration.ps1 used for the redirect URI.
azd env set AZURE_BASE_NAME      "$OrgName-stig"     | Out-Null
azd env set CLOUD_ENVIRONMENT    $CloudEnvironment   | Out-Null
azd env set AZURE_CLOUD_ENVIRONMENT $CloudEnvironment | Out-Null
azd env set ENABLE_SCHEDULER     ($EnableScheduler.ToString().ToLowerInvariant()) | Out-Null
azd env set ENABLE_DIAGNOSTICS   ($EnableDiagnostics.ToString().ToLowerInvariant()) | Out-Null
azd env set BUSINESS_HOURS_MODE  ($BusinessHoursMode.ToString().ToLowerInvariant()) | Out-Null
azd env set BUSINESS_HOURS_TIME_ZONE $BusinessHoursTimeZone | Out-Null
azd env set BUSINESS_HOURS_START_HOUR $BusinessHoursStartHour | Out-Null
azd env set BUSINESS_HOURS_END_HOUR $BusinessHoursEndHour | Out-Null
azd env set AUTO_SHUTDOWN_OUTSIDE_BUSINESS_HOURS ($AutoShutdownOutsideBusinessHours.ToString().ToLowerInvariant()) | Out-Null

azd up --no-prompt
if ($LASTEXITCODE -ne 0) { Write-Error 'azd up failed. See output above.'; exit $LASTEXITCODE }
Write-Host ''

# ── 5. Post-deploy wiring ────────────────────────────────────────────────────
Write-Host '─── Step 3/3 — post-deploy RBAC ──────────────────────────────────'
$outputs = azd env get-values -o json 2>$null | ConvertFrom-Json
$backendPrincipalId  = $outputs.BACKEND_PRINCIPAL_ID
$functionPrincipalId = $outputs.FUNCTION_PRINCIPAL_ID

& "$PSScriptRoot/post-deploy.ps1" `
  -BackendClientId     $reg.clientId `
  -BackendPrincipalId  $backendPrincipalId `
  -FunctionPrincipalId $functionPrincipalId `
  -SubscriptionId      $account.id

Write-Host ''
Write-Host '═══ Done ══════════════════════════════════════════════════════════'
Write-Host ''
Write-Host "  Frontend : $($reg.frontendUri)"
Write-Host ''
Write-Host '  You were granted the Admin role during app-reg bootstrap.'
Write-Host '  Sign in there to verify, then add other users in the Entra portal:'
Write-Host '    Enterprise applications -> ' $reg.displayName ' -> Users and groups'
Write-Host ''
