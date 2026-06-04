<#
.SYNOPSIS
  Creates the Microsoft Entra app registration the dashboard needs, end-to-end.

.DESCRIPTION
  Automates everything the README used to ask a human to do by hand:

    - Creates the app registration with the right display name.
    - Adds the SPA redirect URI for the deployed frontend.
    - Exposes the API with the `access_as_user` delegated scope.
    - Defines the three RBAC app roles (admin / operator / auditor).
    - Generates a 2-year client secret.
    - Grants the *current* signed-in user the `admin` app role so the first
      login works without an extra Azure portal trip.

  Output is the three values the deployment templates need:
      Tenant ID, Application (client) ID, Client secret.

  Re-running the script is safe — it updates an existing registration with the
  same display name instead of creating duplicates.

.PARAMETER OrgName
  Short identifier used as the resource prefix (matches the deployment wizard's
  "Organization name" field). 3–14 lowercase letters / digits. Default: stigdash.

.PARAMETER CloudEnvironment
  AzureCloud | AzureUSGovernment | AzureUSGovernmentDoD. Default: AzureCloud.
  Drives the App Service hostname suffix used for the redirect URI.

.PARAMETER DisplayName
  Optional override for the app registration display name.
  Default: "<OrgName> STIG Dashboard".

.PARAMETER GrantAdminToSelf
  If $true (default) grants the current signed-in user the `admin` app role on
  the new registration so the first login is not locked out.

.EXAMPLE
  ./scripts/create-app-registration.ps1 -OrgName contoso

.EXAMPLE
  ./scripts/create-app-registration.ps1 -OrgName contoso -CloudEnvironment AzureUSGovernment

.NOTES
  Requires: Azure CLI (`az`) signed in to the target tenant with at least
  the "Application Developer" Entra role (to create app registrations) and
  the ability to add app-role assignments on yourself.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)]
  [ValidatePattern('^[a-z][a-z0-9]{2,13}$')]
  [string]$OrgName,

  [ValidateSet('AzureCloud','AzureUSGovernment','AzureUSGovernmentDoD')]
  [string]$CloudEnvironment = 'AzureCloud',

  [string]$DisplayName = $null,

  [bool]$GrantAdminToSelf = $true
)

$ErrorActionPreference = 'Stop'

if (-not $DisplayName) { $DisplayName = "$OrgName STIG Dashboard" }

# Hostname suffix matches what main.bicep / azuredeploy.json pick at deploy time.
$appHostSuffix = switch ($CloudEnvironment) {
  'AzureUSGovernment'    { 'azurewebsites.us' }
  'AzureUSGovernmentDoD' { 'azurewebsites.us' }
  default                { 'azurewebsites.net' }
}
$frontendUri = "https://$OrgName-stig-web.$appHostSuffix"

Write-Host ''
Write-Host '─── Azure STIG Dashboard ─── app registration bootstrap ─────────'
Write-Host "  Display name : $DisplayName"
Write-Host "  Cloud        : $CloudEnvironment"
Write-Host "  Redirect URI : $frontendUri"
Write-Host '──────────────────────────────────────────────────────────────────'
Write-Host ''

# ── 0. Verify az login ────────────────────────────────────────────────────────
$account = az account show --only-show-errors -o json 2>$null | ConvertFrom-Json
if (-not $account) {
  Write-Error "Not signed in. Run 'az login' (or 'az login --use-device-code') first."
  exit 1
}
$tenantId = $account.tenantId
Write-Host "[1/6] Signed in to tenant $tenantId as $($account.user.name)."

# ── 1. Find or create the app registration ───────────────────────────────────
$existing = az ad app list --display-name "$DisplayName" --only-show-errors -o json | ConvertFrom-Json
if ($existing -and $existing.Count -gt 0) {
  $appId   = $existing[0].appId
  $objectId = $existing[0].id
  Write-Host "[2/6] Existing registration found (appId=$appId) — updating in place."
} else {
  $created = az ad app create --display-name "$DisplayName" --sign-in-audience AzureADMyOrg --only-show-errors -o json | ConvertFrom-Json
  $appId    = $created.appId
  $objectId = $created.id
  Write-Host "[2/6] Created new app registration (appId=$appId)."
}

# ── 2. Configure SPA redirect URI ────────────────────────────────────────────
az ad app update --id $appId --set "spa.redirectUris=['$frontendUri']" --only-show-errors | Out-Null
# Also add localhost for dev convenience.
az ad app update --id $appId --set "spa.redirectUris=['$frontendUri','http://localhost:5173']" --only-show-errors | Out-Null
Write-Host "[3/6] SPA redirect URIs set ($frontendUri, http://localhost:5173)."

# ── 3. Application ID URI + access_as_user scope ─────────────────────────────
$identifierUri = "api://$appId"
az ad app update --id $appId --identifier-uris $identifierUri --only-show-errors | Out-Null

$scopeId = [guid]::NewGuid().ToString()
$manifestApi = @{
  acceptMappedClaims         = $null
  knownClientApplications    = @()
  requestedAccessTokenVersion = 2
  oauth2PermissionScopes = @(@{
    id                      = $scopeId
    adminConsentDescription = 'Allow the app to call the STIG Dashboard API on behalf of the signed-in user.'
    adminConsentDisplayName = 'Access STIG Dashboard API'
    isEnabled               = $true
    type                    = 'User'
    userConsentDescription  = 'Allow the app to access the STIG Dashboard API on your behalf.'
    userConsentDisplayName  = 'Access STIG Dashboard API'
    value                   = 'access_as_user'
  })
  preAuthorizedApplications  = @()
} | ConvertTo-Json -Depth 8 -Compress

$apiFile = New-TemporaryFile
Set-Content -Path $apiFile -Value $manifestApi -Encoding utf8
az ad app update --id $appId --set "api=@$apiFile" --only-show-errors | Out-Null
Remove-Item $apiFile -Force
Write-Host "[4/6] Identifier URI $identifierUri + access_as_user scope configured."

# ── 4. App roles (admin / issm / isso / operator / auditor) ──────────────────
$adminRoleId    = [guid]::NewGuid().ToString()
$issmRoleId     = [guid]::NewGuid().ToString()
$issoRoleId     = [guid]::NewGuid().ToString()
$operatorRoleId = [guid]::NewGuid().ToString()
$auditorRoleId  = [guid]::NewGuid().ToString()

$appRoles = @(
  @{
    id                  = $adminRoleId
    allowedMemberTypes  = @('User','Application')
    description         = 'Full administrative access to the STIG Dashboard.'
    displayName         = 'Admin'
    isEnabled           = $true
    value               = 'admin'
  },
  @{
    id                  = $issmRoleId
    allowedMemberTypes  = @('User','Application')
    description         = 'ISSM — approve POA&Ms, exceptions and remediation; assign roles (separation of duties).'
    displayName         = 'ISSM'
    isEnabled           = $true
    value               = 'issm'
  },
  @{
    id                  = $issoRoleId
    allowedMemberTypes  = @('User','Application')
    description         = 'ISSO — operator access plus authoring POA&Ms and exceptions.'
    displayName         = 'ISSO'
    isEnabled           = $true
    value               = 'isso'
  },
  @{
    id                  = $operatorRoleId
    allowedMemberTypes  = @('User','Application')
    description         = 'Trigger scans, edit findings, run remediation playbooks.'
    displayName         = 'Operator'
    isEnabled           = $true
    value               = 'operator'
  },
  @{
    id                  = $auditorRoleId
    allowedMemberTypes  = @('User','Application')
    description         = 'Read-only access to compliance data and exports.'
    displayName         = 'Auditor'
    isEnabled           = $true
    value               = 'auditor'
  }
) | ConvertTo-Json -Depth 6 -Compress

$rolesFile = New-TemporaryFile
Set-Content -Path $rolesFile -Value $appRoles -Encoding utf8
az ad app update --id $appId --app-roles "@$rolesFile" --only-show-errors | Out-Null
Remove-Item $rolesFile -Force
Write-Host "[5/6] App roles defined: admin, issm, isso, operator, auditor."

# ── 4b. Emit group membership in tokens (the 'use existing Entra groups' path) ─
# 'ApplicationGroup' emits only groups assigned to this app, which keeps the
# 'groups' claim small and avoids the >200-group overage that drops the claim.
az ad app update --id $appId --set "groupMembershipClaims=ApplicationGroup" --only-show-errors | Out-Null
Write-Host "      Group membership claim set to ApplicationGroup (group->role mapping enabled)."

# ── 5. Service principal (required for app-role assignments) ─────────────────
$sp = az ad sp list --filter "appId eq '$appId'" --only-show-errors -o json | ConvertFrom-Json
if (-not $sp -or $sp.Count -eq 0) {
  az ad sp create --id $appId --only-show-errors | Out-Null
  $sp = az ad sp list --filter "appId eq '$appId'" --only-show-errors -o json | ConvertFrom-Json
}
$spObjectId = $sp[0].id

# ── 6. Grant the signed-in user the admin app role ───────────────────────────
if ($GrantAdminToSelf) {
  $me = az ad signed-in-user show --only-show-errors -o json | ConvertFrom-Json
  if ($me) {
    # Refresh app-roles list to get the assigned admin role ID (in case the
    # registration already existed and the IDs we generated above were ignored).
    $appFresh = az ad app show --id $appId --only-show-errors -o json | ConvertFrom-Json
    $adminRoleIdEffective = ($appFresh.appRoles | Where-Object { $_.value -eq 'admin' } | Select-Object -First 1).id

    $existingAssignment = az rest --method GET `
      --uri "https://graph.microsoft.com/v1.0/users/$($me.id)/appRoleAssignments" `
      --only-show-errors -o json | ConvertFrom-Json
    $already = $existingAssignment.value | Where-Object { $_.appRoleId -eq $adminRoleIdEffective -and $_.resourceId -eq $spObjectId }

    if (-not $already) {
      $body = @{
        principalId = $me.id
        resourceId  = $spObjectId
        appRoleId   = $adminRoleIdEffective
      } | ConvertTo-Json -Compress
      az rest --method POST `
        --uri "https://graph.microsoft.com/v1.0/users/$($me.id)/appRoleAssignments" `
        --headers 'Content-Type=application/json' `
        --body $body --only-show-errors | Out-Null
    }
    Write-Host "[6/6] Granted admin role to $($me.userPrincipalName)."
  } else {
    Write-Warning "Could not resolve the signed-in user — skipping admin grant."
  }
} else {
  Write-Host "[6/6] Skipping admin grant (use -GrantAdminToSelf:`$true to enable)."
}

# ── 7. Client secret ─────────────────────────────────────────────────────────
$secretJson = az ad app credential reset --id $appId --display-name "auto-bootstrap-$(Get-Date -Format yyyyMMdd)" --years 2 --append --only-show-errors -o json | ConvertFrom-Json
$clientSecret = $secretJson.password

# ── Output ───────────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '════════════════════════════════════════════════════════════════'
Write-Host ' DONE — paste these into the Deploy-to-Azure wizard:'
Write-Host '════════════════════════════════════════════════════════════════'
Write-Host "  Tenant ID     : $tenantId"
Write-Host "  Client ID     : $appId"
Write-Host "  Client secret : $clientSecret"
Write-Host '════════════════════════════════════════════════════════════════'
Write-Host ''
Write-Host ' Or for azd up:'
Write-Host "   azd env set AZURE_TENANT_ID     $tenantId"
Write-Host "   azd env set AZURE_CLIENT_ID     $appId"
Write-Host "   azd env set AZURE_CLIENT_SECRET $clientSecret"
Write-Host ''
Write-Host ' Save the client secret now — it cannot be retrieved later.'
Write-Host ''

# Machine-readable output for the deploy.ps1 wrapper to consume.
[pscustomobject]@{
  tenantId       = $tenantId
  clientId       = $appId
  clientSecret   = $clientSecret
  appObjectId    = $objectId
  spObjectId     = $spObjectId
  frontendUri    = $frontendUri
  displayName    = $DisplayName
}
