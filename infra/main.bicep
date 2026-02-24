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

// ── Variables ─────────────────────────────────────────────────────────────────
var planName     = '${baseName}-plan'
var backendName  = '${baseName}-api'
var frontendName = '${baseName}-web'
var dbServerName = '${baseName}-pg'
var dbName       = 'stigdashboard'
var aiName       = '${baseName}-ai'
var registryName = replace('${baseName}acr', '-', '')

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
        { name: 'AZURE_TENANT_ID',                value: azureTenantId                                  }
        { name: 'AZURE_CLIENT_ID',                value: azureClientId                                  }
        { name: 'AZURE_CLIENT_SECRET',            value: azureClientSecret                               }
        { name: 'DATABASE_URL',                   value: 'postgresql://${dbAdminLogin}:${dbAdminPassword}@${pgServer.properties.fullyQualifiedDomainName}:5432/${dbName}?sslmode=require' }
        { name: 'DB_SSL',                         value: 'true'                                         }
        { name: 'APPINSIGHTS_INSTRUMENTATIONKEY', value: appInsights.properties.InstrumentationKey      }
        { name: 'FRONTEND_URL',                   value: 'https://${frontendName}.azurewebsites.net'    }
        { name: 'WEBSITE_NODE_DEFAULT_VERSION',   value: '~20'                                          }
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'true'                                         }
      ]
    }
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
      http20Enabled: true
      minTlsVersion: '1.2'
      appSettings: [
        { name: 'VITE_AZURE_CLIENT_ID', value: azureClientId   }
        { name: 'VITE_AZURE_TENANT_ID', value: azureTenantId   }
        { name: 'VITE_API_URL',         value: 'https://${backendName}.azurewebsites.net/api' }
        { name: 'VITE_MOCK_MODE',       value: mockMode ? 'true' : 'false' }
      ]
    }
  }
}

// ── Outputs ────────────────────────────────────────────────────────────────────
output backendUrl   string = 'https://${backendApp.properties.defaultHostName}'
output frontendUrl  string = 'https://${frontendApp.properties.defaultHostName}'
output dbServerFqdn string = pgServer.properties.fullyQualifiedDomainName
output aiKey        string = appInsights.properties.InstrumentationKey
output backendPrincipalId string = backendApp.identity.principalId
