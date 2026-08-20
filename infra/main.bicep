@description('Base name used for all resources (lowercase letters and numbers only, 3-20 chars)')
@minLength(3)
@maxLength(20)
param baseName string = 'stigdash'

@description('Azure region for all resources')
param location string = resourceGroup().location

@description('App Service SKU (used when autoSizeByTrackedHosts=false)')
@allowed(['F1', 'B1', 'B2', 'S1', 'S2', 'P1v3'])
param appServiceSku string = 'B1'

@description('When true, App Service SKU + diagnostics + scheduler defaults are derived from trackedHostCount')
param autoSizeByTrackedHosts bool = true

@description('Estimated number of hosts this deployment will track')
@minValue(1)
param trackedHostCount int = 25

@description('Azure AD tenant ID for OIDC auth')
param azureTenantId string

@description('Azure AD client ID (app registration)')
param azureClientId string

@description('Azure AD client secret (store in Key Vault in production)')
@secure()
param azureClientSecret string

@description('PostgreSQL administrator login')
param dbAdminLogin string = 'stigadmin'

@description('PostgreSQL administrator password')
@secure()
param dbAdminPassword string

@description('Demo mode — serves seeded sample data, disables sign-in and accepts every API request unauthenticated. Never enable for a deployment holding real data.')
param mockMode bool = false

@description('Target Azure cloud environment')
@allowed([
  'AzureCloud'
  'AzureUSGovernment'
  'AzureUSGovernmentDoD'
])
param cloudEnvironment string = 'AzureCloud'

@description('Enforce strict finding traceability on exports')
param strictTraceability bool = true

@description('When true, disable public telemetry/query and require explicit ingress CIDR allow-list for App Services')
param lockdownNetworking bool = false

@description('Allowed ingress CIDRs for frontend/backend when lockdownNetworking=true')
param allowedIngressCidrs array = []

@description('Optional resource group name containing VMs/Arc machines that this app may remediate')
param remediationTargetResourceGroupName string = ''

@description('Provision the scheduled-scan Azure Function App + Storage on a Consumption plan')
param enableScheduler bool = true

@description('Forward backend + Function App diagnostics to Log Analytics so Sentinel/Splunk can pull from there')
param enableDiagnostics bool = true

@description('When true, scheduled jobs only run during the configured business-hours window')
param businessHoursMode bool = false

@description('IANA timezone used for business-hours gating in the Function App (for example: UTC, America/New_York)')
param businessHoursTimeZone string = 'UTC'

@description('Business-hours start hour (0-23, inclusive) in businessHoursTimeZone')
@minValue(0)
@maxValue(23)
param businessHoursStartHour int = 8

@description('Business-hours end hour (0-23, exclusive) in businessHoursTimeZone')
@minValue(0)
@maxValue(23)
param businessHoursEndHour int = 18

@description('When true, the Function App will stop the web apps + PostgreSQL outside business hours and start them before business hours')
param autoShutdownOutsideBusinessHours bool = false

@description('Start schedule for business-hours auto-start (NCRONTAB with seconds, UTC). Default: 07:45 UTC weekdays')
param businessHoursStartCron string = '0 45 7 * * 1-5'

@description('Stop schedule for business-hours auto-shutdown (NCRONTAB with seconds, UTC). Default: 18:15 UTC weekdays')
param businessHoursStopCron string = '0 15 18 * * 1-5'

@description('Optional incoming-webhook URL for Microsoft Teams compliance drift alerts')
param teamsWebhookUrl string = ''

@description('CAT I open finding threshold for drift alerts (0 = alert on any open CAT I)')
param driftCat1Threshold int = 0

// Release builds pin these to signed, immutable digests; azd leaves them empty
// and deploys the app code from source instead.
@description('Backend container image, e.g. ghcr.io/org/stig-backend@sha256:... Leave empty to deploy code from source (azd).')
param backendImage string = ''

@description('Frontend container image, e.g. ghcr.io/org/stig-frontend@sha256:... Leave empty to deploy code from source (azd).')
param frontendImage string = ''

@description('Public URL of the scheduler Function zip package. Leave empty to deploy code from source (azd).')
param schedulerPackageUrl string = ''

// ── Variables ─────────────────────────────────────────────────────────────────
var planName     = '${baseName}-plan'
var backendName  = '${baseName}-api'
var frontendName = '${baseName}-web'
var dbServerName = '${baseName}-pg'
var dbName       = 'stigdashboard'
var aiName       = '${baseName}-ai'
var lawName      = '${baseName}-law'
var funcName     = '${baseName}-func'
var funcStorageName = take(replace('${baseName}funcsa', '-', ''), 24)
var keyVaultName = take(replace('${baseName}-stig-kv', '-', ''), 24)
// Built-in role: Key Vault Secrets User
var kvSecretsUserRoleId = '4633458b-17de-457c-a5dd-322bbab69ee3'
var isGov = cloudEnvironment == 'AzureUSGovernment' || cloudEnvironment == 'AzureUSGovernmentDoD'
var appHostSuffix = isGov ? 'azurewebsites.us' : 'azurewebsites.net'
var authorityHost = isGov ? 'https://login.microsoftonline.us' : 'https://login.microsoftonline.com'
var graphHost = isGov ? 'https://graph.microsoft.us' : 'https://graph.microsoft.com'
var armHost = isGov ? 'https://management.usgovcloudapi.net' : 'https://management.azure.com'
var backendLinuxFxVersion  = empty(backendImage)  ? 'NODE|20-lts' : 'DOCKER|${backendImage}'
var frontendLinuxFxVersion = empty(frontendImage) ? 'NODE|20-lts' : 'DOCKER|${frontendImage}'
var backendRegistryUrl  = 'https://${first(split(backendImage, '/'))}'
var frontendRegistryUrl = 'https://${first(split(frontendImage, '/'))}'
var autoAppServiceSku = trackedHostCount <= 150 ? 'B1' : 'S1'
var autoEnableScheduler = trackedHostCount > 25
var autoEnableDiagnostics = trackedHostCount > 150
var effectiveAppServiceSku = autoSizeByTrackedHosts ? autoAppServiceSku : appServiceSku
var effectiveEnableScheduler = autoSizeByTrackedHosts ? autoEnableScheduler : enableScheduler
var effectiveEnableDiagnostics = autoSizeByTrackedHosts ? autoEnableDiagnostics : enableDiagnostics
var enableBusinessHoursShutdown = effectiveEnableScheduler && businessHoursMode && autoShutdownOutsideBusinessHours

// ── App Service Plan ───────────────────────────────────────────────────────────
resource appServicePlan 'Microsoft.Web/serverfarms@2023-01-01' = {
  name: planName
  location: location
  sku: {
    name: effectiveAppServiceSku
  }
  kind: 'linux'
  properties: {
    reserved: true
  }
}

// ── Application Insights ───────────────────────────────────────────────────────
resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: aiName
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    publicNetworkAccessForIngestion: lockdownNetworking ? 'Disabled' : 'Enabled'
    publicNetworkAccessForQuery: lockdownNetworking ? 'Disabled' : 'Enabled'
  }
}
// ── Key Vault (Audit #3 — store AZURE_CLIENT_SECRET + DB password) ───────────
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    enablePurgeProtection: true
    softDeleteRetentionInDays: 90
    publicNetworkAccess: lockdownNetworking ? 'Disabled' : 'Enabled'
  }
}

resource kvSecretClientSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'AZURE-CLIENT-SECRET'
  properties: { value: azureClientSecret }
}

// Only the password is stored as a secret. The full connection string is
// composed by the backend at runtime from the discrete DB_* settings, so no
// credential is ever embedded in a template variable or deployment output.
resource kvSecretDbPassword 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'DB-PASSWORD'
  properties: { value: dbAdminPassword }
}
// ── PostgreSQL Flexible Server ─────────────────────────────────────────────────
resource pgServer 'Microsoft.DBforPostgreSQL/flexibleServers@2023-06-01-preview' = {
  name: dbServerName
  location: location
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    administratorLogin: dbAdminLogin
    administratorLoginPassword: dbAdminPassword
    version: '16'
    storage: {
      storageSizeGB: 32
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    authConfig: {
      activeDirectoryAuth: 'Disabled'
      passwordAuth: 'Enabled'
    }
  }
}

resource pgDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-06-01-preview' = {
  parent: pgServer
  name: dbName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// Enforce TLS on all client connections (defense-in-depth; pairs with the
// backend's certificate-verifying TLS connection). Clients that connect
// without SSL are rejected by the server.
resource pgRequireSsl 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2023-06-01-preview' = {
  parent: pgServer
  name: 'require_secure_transport'
  properties: {
    value: 'ON'
    source: 'user-override'
  }
}

// Allow Azure-hosted services (App Service) to reach the flexible server.
// 0.0.0.0 -> 0.0.0.0 is the special "Allow Azure services" rule.
resource pgFirewallAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-06-01-preview' = if (!lockdownNetworking) {
  parent: pgServer
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

// ── Backend App Service (API) ─────────────────────────────────────────────────
var backendAppSettings = concat([
  { name: 'NODE_ENV',                       value: 'production'                                    }
  { name: 'MOCK_MODE',                      value: mockMode ? 'true' : 'false'                    }
  { name: 'STRICT_TRACEABILITY',            value: strictTraceability ? 'true' : 'false'           }
  { name: 'AZURE_CLOUD',                    value: cloudEnvironment                                }
  { name: 'AZURE_AUTHORITY_HOST',           value: authorityHost                                   }
  { name: 'AZURE_GRAPH_ENDPOINT',           value: graphHost                                       }
  { name: 'AZURE_ARM_ENDPOINT',             value: armHost                                         }
  { name: 'AZURE_TENANT_ID',                value: azureTenantId                                  }
  { name: 'AZURE_CLIENT_ID',                value: azureClientId                                  }
  { name: 'AZURE_CLIENT_SECRET',            value: '@Microsoft.KeyVault(SecretUri=${kvSecretClientSecret.properties.secretUri})' }
  { name: 'DB_HOST',                        value: pgServer.properties.fullyQualifiedDomainName    }
  { name: 'DB_PORT',                        value: '5432'                                         }
  { name: 'DB_NAME',                        value: dbName                                         }
  { name: 'DB_USER',                        value: dbAdminLogin                                   }
  { name: 'DB_PASSWORD',                    value: '@Microsoft.KeyVault(SecretUri=${kvSecretDbPassword.properties.secretUri})' }
  { name: 'DB_SSL',                         value: 'true'                                         }
  { name: 'APPINSIGHTS_INSTRUMENTATIONKEY', value: appInsights.properties.InstrumentationKey      }
  { name: 'FRONTEND_URL',                   value: 'https://${frontendName}.${appHostSuffix}'     }
], empty(backendImage) ? [
  { name: 'WEBSITE_NODE_DEFAULT_VERSION',   value: '~20'                                          }
  { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'true'                                         }
] : [
  { name: 'WEBSITES_PORT',                  value: '3001'                                         }
  { name: 'DOCKER_REGISTRY_SERVER_URL',     value: backendRegistryUrl                             }
  { name: 'WEBSITES_ENABLE_APP_SERVICE_STORAGE', value: 'false'                                   }
])

resource backendApp 'Microsoft.Web/sites@2023-01-01' = {
  name: backendName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: backendLinuxFxVersion
      alwaysOn: effectiveAppServiceSku != 'F1'
      http20Enabled: true
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      ipSecurityRestrictionsDefaultAction: lockdownNetworking ? 'Deny' : 'Allow'
      scmIpSecurityRestrictionsDefaultAction: lockdownNetworking ? 'Deny' : 'Allow'
      ipSecurityRestrictions: [for (cidr, i) in allowedIngressCidrs: {
        ipAddress: cidr
        action: 'Allow'
        priority: 100 + i
        name: 'allow-${i}'
      }]
    }
  }
}

// Applied after the Key Vault RBAC grant so the @Microsoft.KeyVault references
// resolve on first boot instead of leaving the API without DB credentials.
resource backendAppConfig 'Microsoft.Web/sites/config@2023-01-01' = {
  parent: backendApp
  name: 'appsettings'
  properties: toObject(backendAppSettings, s => s.name, s => s.value)
  dependsOn: [
    kvRoleAssignment
  ]
}

// Grant the backend's system-assigned managed identity permission to read
// secrets from the Key Vault (Audit #3).
resource kvRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: keyVault
  name: guid(keyVault.id, backendApp.id, kvSecretsUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsUserRoleId)
    principalId: backendApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Grant the backend's managed identity least-privilege RunCommand rights in the
// remediation target resource group. Deployed as a module scoped to that RG so
// the custom role and assignment are created at the correct scope.
module remediationAccess 'modules/remediationAccess.bicep' = if (!empty(remediationTargetResourceGroupName)) {
  name: 'stig-remediation-access'
  scope: resourceGroup(remediationTargetResourceGroupName)
  params: {
    baseName: baseName
    principalId: backendApp.identity.principalId
  }
}

// ── Frontend App Service (Static HTML served by nginx via Docker) ─────────────
resource frontendApp 'Microsoft.Web/sites@2023-01-01' = {
  name: frontendName
  location: location
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: frontendLinuxFxVersion
      appCommandLine: empty(frontendImage) ? 'npm start' : ''
      http20Enabled: true
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      ipSecurityRestrictionsDefaultAction: lockdownNetworking ? 'Deny' : 'Allow'
      scmIpSecurityRestrictionsDefaultAction: lockdownNetworking ? 'Deny' : 'Allow'
      ipSecurityRestrictions: [for (cidr, i) in allowedIngressCidrs: {
        ipAddress: cidr
        action: 'Allow'
        priority: 100 + i
        name: 'allow-${i}'
      }]
      appSettings: concat([
        // Names consumed by the frontend container entrypoint to render runtime-config.js.
        { name: 'AZURE_CLIENT_ID',           value: azureClientId   }
        { name: 'AZURE_TENANT_ID',           value: azureTenantId   }
        { name: 'AZURE_CLOUD',               value: cloudEnvironment }
        { name: 'AZURE_AUTHORITY_HOST',      value: authorityHost   }
        { name: 'API_URL',                   value: 'https://${backendName}.${appHostSuffix}/api' }
        { name: 'API_SCOPE',                 value: 'api://${azureClientId}/access_as_user' }
        { name: 'MOCK_MODE',                 value: mockMode ? 'true' : 'false' }
        { name: 'WEBSITES_PORT',             value: '8080' }
      ], empty(frontendImage) ? [
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'false' }
      ] : [
        { name: 'DOCKER_REGISTRY_SERVER_URL', value: frontendRegistryUrl }
        { name: 'WEBSITES_ENABLE_APP_SERVICE_STORAGE', value: 'false' }
      ])
    }
  }
}

// ── Log Analytics + Diagnostics (SIEM-ready) ───────────────────────────────
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2022-10-01' = if (effectiveEnableDiagnostics) {
  name: lawName
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    features: { enableLogAccessUsingOnlyResourcePermissions: true }
  }
}

// Stream backend App Service logs + metrics to Log Analytics so Sentinel /
// Splunk / 3rd-party SIEMs can pull from a single workspace.
resource backendDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (effectiveEnableDiagnostics) {
  scope: backendApp
  name: 'siem-stream'
  properties: {
    workspaceId: logAnalytics.id
    logs: [
      { category: 'AppServiceHTTPLogs',         enabled: true }
      { category: 'AppServiceConsoleLogs',      enabled: true }
      { category: 'AppServiceAppLogs',          enabled: true }
      { category: 'AppServiceAuditLogs',        enabled: true }
      { category: 'AppServiceIPSecAuditLogs',   enabled: true }
      { category: 'AppServicePlatformLogs',     enabled: true }
    ]
    metrics: [ { category: 'AllMetrics', enabled: true } ]
  }
}

resource frontendDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (effectiveEnableDiagnostics) {
  scope: frontendApp
  name: 'siem-stream'
  properties: {
    workspaceId: logAnalytics.id
    logs: [
      { category: 'AppServiceHTTPLogs',         enabled: true }
      { category: 'AppServiceConsoleLogs',      enabled: true }
      { category: 'AppServiceAppLogs',          enabled: true }
    ]
    metrics: [ { category: 'AllMetrics', enabled: true } ]
  }
}

resource kvDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (effectiveEnableDiagnostics) {
  scope: keyVault
  name: 'siem-stream'
  properties: {
    workspaceId: logAnalytics.id
    logs: [
      { category: 'AuditEvent',           enabled: true }
      { category: 'AzurePolicyEvaluationDetails', enabled: true }
    ]
    metrics: [ { category: 'AllMetrics', enabled: true } ]
  }
}

// ── Scheduled Scan Function App (Consumption plan) ─────────────────────────
resource funcStorage 'Microsoft.Storage/storageAccounts@2023-01-01' = if (effectiveEnableScheduler) {
  name: funcStorageName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
  }
}

resource funcPlan 'Microsoft.Web/serverfarms@2023-01-01' = if (effectiveEnableScheduler) {
  name: '${funcName}-plan'
  location: location
  sku: { name: 'Y1', tier: 'Dynamic' }
  properties: { reserved: true }
  kind: 'functionapp'
}

resource funcApp 'Microsoft.Web/sites@2023-01-01' = if (effectiveEnableScheduler) {
  name: funcName
  location: location
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: funcPlan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|20'
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      appSettings: concat(empty(schedulerPackageUrl) ? [] : [
        { name: 'WEBSITE_RUN_FROM_PACKAGE',            value: schedulerPackageUrl }
      ], [
        { name: 'AzureWebJobsStorage',                 value: 'DefaultEndpointsProtocol=https;AccountName=${funcStorage.name};AccountKey=${funcStorage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}' }
        { name: 'FUNCTIONS_EXTENSION_VERSION',         value: '~4' }
        { name: 'FUNCTIONS_WORKER_RUNTIME',            value: 'node' }
        { name: 'WEBSITE_NODE_DEFAULT_VERSION',        value: '~20' }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
        { name: 'BACKEND_BASE_URL',                    value: 'https://${backendApp.properties.defaultHostName}' }
        { name: 'BACKEND_API_AUDIENCE',                value: 'api://${azureClientId}' }
        { name: 'TEAMS_WEBHOOK_URL',                   value: teamsWebhookUrl }
        { name: 'DRIFT_CAT1_THRESHOLD',                value: string(driftCat1Threshold) }
        { name: 'BUSINESS_HOURS_MODE',                 value: businessHoursMode ? 'true' : 'false' }
        { name: 'BUSINESS_HOURS_TIME_ZONE',            value: businessHoursTimeZone }
        { name: 'BUSINESS_HOURS_START_HOUR',           value: string(businessHoursStartHour) }
        { name: 'BUSINESS_HOURS_END_HOUR',             value: string(businessHoursEndHour) }
        { name: 'BUSINESS_HOURS_AUTO_SHUTDOWN',        value: autoShutdownOutsideBusinessHours ? 'true' : 'false' }
        { name: 'BUSINESS_HOURS_START_CRON',           value: businessHoursStartCron }
        { name: 'BUSINESS_HOURS_STOP_CRON',            value: businessHoursStopCron }
        { name: 'AZURE_ARM_ENDPOINT',                  value: armHost }
        { name: 'BACKEND_APP_RESOURCE_ID',             value: backendApp.id }
        { name: 'FRONTEND_APP_RESOURCE_ID',            value: frontendApp.id }
        { name: 'POSTGRES_SERVER_RESOURCE_ID',         value: pgServer.id }
      ])
    }
  }
}

resource schedulerOpsRole 'Microsoft.Authorization/roleDefinitions@2022-05-01-preview' = if (enableBusinessHoursShutdown) {
  name: guid(subscription().id, resourceGroup().id, '${baseName}-ops-scheduler-role')
  scope: resourceGroup()
  properties: {
    roleName: '${baseName}-ops-scheduler'
    description: 'Least-privilege role so the scheduler Function can start/stop dashboard web apps and PostgreSQL.'
    type: 'CustomRole'
    assignableScopes: [
      resourceGroup().id
    ]
    permissions: [
      {
        actions: [
          'Microsoft.Web/sites/read'
          'Microsoft.Web/sites/start/action'
          'Microsoft.Web/sites/stop/action'
          'Microsoft.DBforPostgreSQL/flexibleServers/read'
          'Microsoft.DBforPostgreSQL/flexibleServers/start/action'
          'Microsoft.DBforPostgreSQL/flexibleServers/stop/action'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
  }
}

resource schedulerOpsAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableBusinessHoursShutdown) {
  scope: resourceGroup()
  name: guid(resourceGroup().id, funcApp.id, 'ops-scheduler-assignment')
  properties: {
    roleDefinitionId: schedulerOpsRole.id
    principalId: funcApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource funcDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (effectiveEnableScheduler && effectiveEnableDiagnostics) {
  scope: funcApp
  name: 'siem-stream'
  properties: {
    workspaceId: logAnalytics.id
    logs: [
      { category: 'FunctionAppLogs', enabled: true }
    ]
    metrics: [ { category: 'AllMetrics', enabled: true } ]
  }
}

// ── Outputs ────────────────────────────────────────────────────────────────────
// ── Outputs ─────────────────────────────────────────────────────────────────
output cloudEnvironment string = cloudEnvironment
output backendUrl   string = 'https://${backendApp.properties.defaultHostName}'
output frontendUrl  string = 'https://${frontendApp.properties.defaultHostName}'
output redirectUriToConfigure string = 'https://${frontendApp.properties.defaultHostName}'
output dbServerFqdn string = pgServer.properties.fullyQualifiedDomainName
output aiKey        string = appInsights.properties.InstrumentationKey
output backendPrincipalId string = backendApp.identity.principalId
output functionAppName string = effectiveEnableScheduler ? funcApp.name : ''
output functionPrincipalId string = effectiveEnableScheduler ? funcApp.identity.principalId : ''
output logAnalyticsWorkspaceId string = effectiveEnableDiagnostics ? logAnalytics.id : ''
output effectiveAppServiceSku string = effectiveAppServiceSku
output effectiveEnableScheduler bool = effectiveEnableScheduler
output effectiveEnableDiagnostics bool = effectiveEnableDiagnostics

