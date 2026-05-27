<#
.SYNOPSIS
  Post-deploy wiring for the Azure STIG Dashboard.

.DESCRIPTION
  Runs after `azd up` (or after the portal "Deploy to Azure" button finishes).
  Reads outputs from the deployment and:

    1. Grants the backend App Service's managed identity the Azure RBAC
       roles it needs at *subscription* scope so it can read inventory,
       policy state, and Defender assessments:
           - Reader
           - Security Reader
    2. Grants the Function App's managed identity the `operator` app role on
       the backend Entra app registration so scheduledScan / drift alerts can
       call /api/scan/trigger and /api/vulnerabilities/sync.
    3. Reminds the operator about Application ID URI and (optional) eMASS PEM
       upload steps that cannot be fully automated.

  This script is idempotent — re-running it is safe.

.PARAMETER BackendClientId
  The application (client) ID of the backend Entra app registration. Defaults
  to the AZURE_CLIENT_ID env var that azd writes after deployment.

.PARAMETER FunctionPrincipalId
  The principal (object) ID of the Function App's system-assigned MI. Defaults
  to the `functionPrincipalId` deployment output.

.PARAMETER BackendPrincipalId
  The principal (object) ID of the backend App Service's system-assigned MI.
  Defaults to the `backendPrincipalId` deployment output. Required for the
  subscription-scope role grants in step 1.

.PARAMETER SubscriptionId
  Subscription to grant the backend MI Reader + Security Reader on. Defaults
  to the currently-selected `az account` subscription.
#>
param(
  [string]$BackendClientId      = $env:AZURE_CLIENT_ID,
  [string]$FunctionPrincipalId  = $env:FUNCTION_PRINCIPAL_ID,
  [string]$BackendPrincipalId   = $env:BACKEND_PRINCIPAL_ID,
  [string]$SubscriptionId       = $null
)

$ErrorActionPreference = 'Stop'

# ── 0. Subscription-scope RBAC for the backend MI ────────────────────────────
if ($BackendPrincipalId) {
  if (-not $SubscriptionId) {
    $SubscriptionId = (az account show --only-show-errors -o json | ConvertFrom-Json).id
  }
  Write-Host "[post-deploy] Granting backend MI ($BackendPrincipalId) Reader + Security Reader on /subscriptions/$SubscriptionId ..."

  $roles = @(
    @{ name = 'Reader';          id = 'acdd72a7-3385-48ef-bd42-f606fba81ae7' }
    @{ name = 'Security Reader'; id = '39bc4728-0917-49c7-9d2c-d95423bc2eb4' }
  )

  foreach ($role in $roles) {
    $scope = "/subscriptions/$SubscriptionId"
    $existing = az role assignment list --assignee-object-id $BackendPrincipalId --assignee-principal-type ServicePrincipal --role $role.id --scope $scope --only-show-errors -o json 2>$null | ConvertFrom-Json
    if ($existing -and $existing.Count -gt 0) {
      Write-Host "  - $($role.name) already assigned. Skipping."
    } else {
      az role assignment create `
        --assignee-object-id $BackendPrincipalId `
        --assignee-principal-type ServicePrincipal `
        --role $role.id `
        --scope $scope `
        --only-show-errors | Out-Null
      Write-Host "  - $($role.name) granted."
    }
  }
} else {
  Write-Host '[post-deploy] BACKEND_PRINCIPAL_ID not set; skipping subscription-scope role grants.'
  Write-Host '             Pass -BackendPrincipalId or set the env var to assign Reader + Security Reader automatically.'
}

if (-not $BackendClientId) {
  Write-Warning 'AZURE_CLIENT_ID not set. Run `azd env get-values` and pass -BackendClientId to wire the Function App role.'
  exit 0
}
if (-not $FunctionPrincipalId) {
  Write-Host '[post-deploy] FUNCTION_PRINCIPAL_ID not set; skipping Function App role grant (scheduler likely disabled).'
  exit 0
}

Write-Host "[post-deploy] Granting Function App MI ($FunctionPrincipalId) the 'operator' app role on backend $BackendClientId..."

# Resolve backend app registration's service principal + operator app-role id
$backendSp = az ad sp list --filter "appId eq '$BackendClientId'" --query '[0]' -o json | ConvertFrom-Json
if (-not $backendSp) {
  Write-Error "Backend service principal not found for appId $BackendClientId. Make sure the backend app registration exists and has been admin-consented."
  exit 1
}
$operatorRole = $backendSp.appRoles | Where-Object { $_.value -eq 'operator' } | Select-Object -First 1
if (-not $operatorRole) {
  Write-Error "Backend app registration $BackendClientId has no 'operator' app role. Define it under 'App roles' in the registration, then re-run."
  exit 1
}

# Check if assignment already exists
$existing = az rest --method GET `
  --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$FunctionPrincipalId/appRoleAssignments" `
  --query "value[?appRoleId=='$($operatorRole.id)' && resourceId=='$($backendSp.id)'] | [0]" -o json 2>$null

if ($existing -and $existing -ne 'null') {
  Write-Host '[post-deploy] Role already assigned. Skipping.'
} else {
  $body = @{
    principalId = $FunctionPrincipalId
    resourceId  = $backendSp.id
    appRoleId   = $operatorRole.id
  } | ConvertTo-Json -Compress

  az rest --method POST `
    --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$FunctionPrincipalId/appRoleAssignments" `
    --headers 'Content-Type=application/json' `
    --body $body | Out-Null
  Write-Host '[post-deploy] operator role granted.'
}

# Verify Application ID URI is configured
$appUri = $backendSp.servicePrincipalNames | Where-Object { $_ -like 'api://*' } | Select-Object -First 1
if (-not $appUri) {
  Write-Warning "Backend app registration is missing an 'api://...' Application ID URI. The Function App's MI tokens will be rejected. Set this in the registration's 'Expose an API' blade."
} else {
  Write-Host "[post-deploy] Application ID URI verified: $appUri"
}

Write-Host ''
Write-Host '────────────────────────────────────────────────────────────────'
Write-Host ' Optional manual steps (eMASS integration only):'
Write-Host '  1. Upload your DoD PKI PEMs to Key Vault as secrets:'
Write-Host '       az keyvault secret set --vault-name <kv> --name EMASS-CERT-PEM --file ./client.crt'
Write-Host '       az keyvault secret set --vault-name <kv> --name EMASS-KEY-PEM  --file ./client.key'
Write-Host '  2. Add Key Vault references to the backend App Settings:'
Write-Host '       EMASS_CERT_PEM, EMASS_KEY_PEM, EMASS_API_KEY, EMASS_USER_UID, EMASS_BASE_URL'
Write-Host '────────────────────────────────────────────────────────────────'
