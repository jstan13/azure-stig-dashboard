#Requires -Version 7.0
<#
.SYNOPSIS
    Creates the Entra identity a STIG Tracker GPO agent uses for one environment.

.DESCRIPTION
    1. Adds the application-only app roles `gpo-agent-test` and
       `gpo-agent-production` to the dashboard API registration if missing,
       preserving every existing role and its ID.
    2. Finds or creates "<DisplayName> (<Environment>)" as a separate app
       registration, so test and production agents never share credentials.
    3. Uploads the agent's public certificate (no client secret is created).
    4. Grants that agent only the matching environment role.

    Run it twice — once for test, once for production — with different
    certificates. Requires Application Administrator (or equivalent) and an
    `az login` session.

.EXAMPLE
    ./scripts/register-gpo-agent.ps1 -ApiAppId <dashboard-client-id> -Environment test -CertificatePath .\gpo-agent-test.cer
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][guid]$ApiAppId,
    [Parameter(Mandatory)][ValidateSet('test', 'production')][string]$Environment,
    [Parameter(Mandatory)][string]$CertificatePath,
    [string]$DisplayName = 'STIG Tracker GPO Agent',
    [ValidateSet('AzureCloud', 'AzureUSGovernment', 'AzureUSGovernmentDoD')][string]$CloudEnvironment = 'AzureCloud'
)

$ErrorActionPreference = 'Stop'
$graph = switch ($CloudEnvironment) {
    'AzureUSGovernment' { 'https://graph.microsoft.us' }
    'AzureUSGovernmentDoD' { 'https://dod-graph.microsoft.us' }
    default { 'https://graph.microsoft.com' }
}

function Invoke-Graph([string]$Method, [string]$Path, $Body) {
    $azArgs = @('rest', '--method', $Method, '--uri', "$graph/v1.0$Path", '--resource', $graph, '--only-show-errors', '-o', 'json')
    $file = $null
    if ($null -ne $Body) {
        $file = New-TemporaryFile
        $Body | ConvertTo-Json -Depth 10 | Set-Content -Path $file -Encoding utf8
        $azArgs += @('--headers', 'Content-Type=application/json', '--body', "@$file")
    }
    try {
        $out = az @azArgs
        if ($LASTEXITCODE -ne 0) { throw "Graph $Method $Path failed" }
        if ($out) { $out | ConvertFrom-Json }
    }
    finally { if ($file) { Remove-Item $file -Force } }
}

function Invoke-Az {
    $out = az @args --only-show-errors -o json
    if ($LASTEXITCODE -ne 0) { throw "az $($args -join ' ') failed" }
    if ($out) { $out | ConvertFrom-Json }
}

if (-not (Test-Path -LiteralPath $CertificatePath)) { throw "Certificate not found: $CertificatePath" }
if (-not (az account show --only-show-errors -o json 2>$null)) { throw "Run 'az login' first." }

# ── 1. Agent app roles on the dashboard API ─────────────────────────────────
$api = Invoke-Az ad app show --id "$ApiAppId"
$roles = @($api.appRoles)
$wanted = [ordered]@{
    'gpo-agent-test'       = 'GPO agent (test) — deploy and validate DISA GPOs in the test domain.'
    'gpo-agent-production' = 'GPO agent (production) — stage, release, and roll back DISA GPOs in production.'
}
$added = $false
foreach ($value in $wanted.Keys) {
    if ($roles | Where-Object { $_.value -eq $value }) { continue }
    $roles += [pscustomobject]@{
        id = [guid]::NewGuid().ToString(); allowedMemberTypes = @('Application'); isEnabled = $true
        value = $value; displayName = $value; description = $wanted[$value]
    }
    $added = $true
}
if ($added) {
    Invoke-Graph PATCH "/applications/$($api.id)" @{ appRoles = $roles } | Out-Null
    Write-Host 'Added GPO agent app roles to the dashboard API registration.'
    $api = Invoke-Az ad app show --id "$ApiAppId"
}
$roleId = ($api.appRoles | Where-Object { $_.value -eq "gpo-agent-$Environment" }).id
$apiSp = Invoke-Az ad sp show --id "$ApiAppId"

# ── 2. Agent registration (one per environment) ──────────────────────────────
$name = "$DisplayName ($Environment)"
$agent = @(Invoke-Az ad app list --display-name $name) | Select-Object -First 1
if (-not $agent) {
    $agent = Invoke-Az ad app create --display-name $name --sign-in-audience AzureADMyOrg
    Write-Host "Created $name (appId $($agent.appId))."
}
$agentSp = @(Invoke-Az ad sp list --filter "appId eq '$($agent.appId)'") | Select-Object -First 1
if (-not $agentSp) { $agentSp = Invoke-Az ad sp create --id $agent.appId }

# ── 3. Certificate credential ────────────────────────────────────────────────
az ad app credential reset --id $agent.appId --cert "@$((Resolve-Path $CertificatePath).Path)" --append --only-show-errors -o none
if ($LASTEXITCODE -ne 0) { throw 'Uploading the certificate failed' }

# ── 4. Grant only this environment's role ────────────────────────────────────
$assigned = (Invoke-Graph GET "/servicePrincipals/$($agentSp.id)/appRoleAssignments").value |
    Where-Object { $_.resourceId -eq $apiSp.id -and $_.appRoleId -eq $roleId }
if (-not $assigned) {
    Invoke-Graph POST "/servicePrincipals/$($agentSp.id)/appRoleAssignments" @{
        principalId = $agentSp.id; resourceId = $apiSp.id; appRoleId = $roleId
    } | Out-Null
}

$tenant = (az account show --only-show-errors -o json | ConvertFrom-Json).tenantId
Write-Host ''
Write-Host "Agent identity ready. Use these values in agent.config.json:"
Write-Host "  Auth.TenantId : $tenant"
Write-Host "  Auth.ClientId : $($agent.appId)"
Write-Host "  Auth.Scope    : api://$ApiAppId/.default"
Write-Host "  Role granted  : gpo-agent-$Environment"
