@description('Base name used for all resources (lowercase letters and numbers only, 3-20 chars)')
@minLength(3)
@maxLength(20)
param baseName string = 'stigdash'

@description('Azure region for all resources')
param location string = resourceGroup().location

@description('App Service SKU')
@allowed(['F1', 'B1', 'B2', 'S1', 'S2', 'P1v3'])
param appServiceSku string = 'B1'

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

@description('Enable mock mode — no real Azure subscription required')
param mockMode bool = false

@description('Provision the scheduled-scan Azure Function App + Storage on a Consumption plan')
param enableScheduler bool = true

@description('Forward backend + Function App diagnostics to Log Analytics so Sentinel/Splunk can pull from there')
param enableDiagnostics bool = true

@description('Optional incoming-webhook URL for Microsoft Teams compliance drift alerts')
param teamsWebhookUrl string = ''

@description('CAT I open finding threshold for drift alerts (0 = alert on any open CAT I)')
param driftCat1Threshold int = 0

// ── Variables ─────────────────────────────────────────────────────────────────
var planName     = '${baseName}-plan'
var backendName  = '${baseName}-api'
var frontendName = '${baseName}-web'
var dbServerName = '${baseName}-pg'
var dbName       = 'stigdashboard'
var aiName       = '${baseName}-ai'
var registryName = replace('${baseName}acr', '-', '')
var lawName      = '${baseName}-law'
var funcName     = '${baseName}-func'
var funcStorageName = take(replace('${baseName}funcsa', '-', ''), 24)
var keyVaultName = take(replace('${baseName}-stig-kv', '-', ''), 24)
// Built-in role: Key Vault Secrets User
var kvSecretsUserRoleId = '4633458b-17de-457c-a5dd-322bbab69ee3'
var databaseUrl = 'postgresql://${dbAdminLogin}:${dbAdminPassword}@${pgServer.properties.fullyQualifiedDomainName}:5432/${dbName}?sslmode=require'

// ── App Service Plan ───────────────────────────────────────────────────────────
resource appServicePlan 'Microsoft.Web/serverfarms@2023-01-01' = {
  name: planName
  location: location
  sku: {
    name: appServiceSku
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
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}
// ── Key Vault (Audit #3 — store AZURE_CLIENT_SECRET + DATABASE_URL) ──────────
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    publicNetworkAccess: 'Enabled'
  }
}

resource kvSecretClientSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'AZURE-CLIENT-SECRET'
  properties: { value: azureClientSecret }
}

resource kvSecretDbUrl 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'DATABASE-URL'
  properties: { value: databaseUrl }
  dependsOn: [ pgServer ]
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

// Allow Azure-hosted services (App Service) to reach the flexible server.
// 0.0.0.0 -> 0.0.0.0 is the special "Allow Azure services" rule.
resource pgFirewallAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-06-01-preview' = {
  parent: pgServer
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

// ── Backend App Service (API) ─────────────────────────────────────────────────
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
      linuxFxVersion: 'NODE|20-lts'
      alwaysOn: appServiceSku != 'F1'
      http20Enabled: true
      minTlsVersion: '1.2'
      appSettings: [
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
        { name: 'DATABASE_URL',                   value: '@Microsoft.KeyVault(SecretUri=${kvSecretDbUrl.properties.secretUri})' }
        { name: 'DB_SSL',                         value: 'true'                                         }
        { name: 'APPINSIGHTS_INSTRUMENTATIONKEY', value: appInsights.properties.InstrumentationKey      }
        { name: 'FRONTEND_URL',                   value: 'https://${frontendName}.${appHostSuffix}'     }
        { name: 'WEBSITE_NODE_DEFAULT_VERSION',   value: '~20'                                          }
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'true'                                         }
      ]
    }
  }
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

// ── Frontend App Service (Static HTML served by nginx via Docker) ─────────────
resource frontendApp 'Microsoft.Web/sites@2023-01-01' = {
  name: frontendName
  location: location
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|20-lts'
      appCommandLine: 'npm start'
      http20Enabled: true
      minTlsVersion: '1.2'
      appSettings: [
        { name: 'VITE_AZURE_CLIENT_ID',      value: azureClientId   }
        { name: 'VITE_AZURE_TENANT_ID',      value: azureTenantId   }
        { name: 'VITE_AZURE_CLOUD',          value: cloudEnvironment }
        { name: 'VITE_AZURE_AUTHORITY_HOST', value: authorityHost   }
        { name: 'VITE_API_URL',              value: 'https://${backendName}.${appHostSuffix}/api' }
        { name: 'VITE_MOCK_MODE',            value: mockMode ? 'true' : 'false' }
        { name: 'WEBSITES_PORT',             value: '8080' }
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'false' }
      ]
    }
  }
}

// ── Log Analytics + Diagnostics (SIEM-ready) ───────────────────────────────
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2022-10-01' = if (enableDiagnostics) {
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
resource backendDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (enableDiagnostics) {
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

resource frontendDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (enableDiagnostics) {
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

resource kvDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (enableDiagnostics) {
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
resource funcStorage 'Microsoft.Storage/storageAccounts@2023-01-01' = if (enableScheduler) {
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

resource funcPlan 'Microsoft.Web/serverfarms@2023-01-01' = if (enableScheduler) {
  name: '${funcName}-plan'
  location: location
  sku: { name: 'Y1', tier: 'Dynamic' }
  properties: { reserved: true }
  kind: 'functionapp'
}

resource funcApp 'Microsoft.Web/sites@2023-01-01' = if (enableScheduler) {
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
      appSettings: [
        { name: 'AzureWebJobsStorage',                 value: 'DefaultEndpointsProtocol=https;AccountName=${funcStorage.name};AccountKey=${funcStorage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}' }
        { name: 'FUNCTIONS_EXTENSION_VERSION',         value: '~4' }
        { name: 'FUNCTIONS_WORKER_RUNTIME',            value: 'node' }
        { name: 'WEBSITE_NODE_DEFAULT_VERSION',        value: '~20' }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
        { name: 'BACKEND_BASE_URL',                    value: 'https://${backendApp.properties.defaultHostName}' }
        { name: 'BACKEND_API_AUDIENCE',                value: 'api://${azureClientId}' }
        { name: 'TEAMS_WEBHOOK_URL',                   value: teamsWebhookUrl }
        { name: 'DRIFT_CAT1_THRESHOLD',                value: string(driftCat1Threshold) }
      ]
    }
  }
}

resource funcDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (enableScheduler && enableDiagnostics) {
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
output functionAppName string = enableScheduler ? funcApp.name : ''
output functionPrincipalId string = enableScheduler ? funcApp.identity.principalId : ''
output logAnalyticsWorkspaceId string = enableDiagnostics ? logAnalytics.id : ''

