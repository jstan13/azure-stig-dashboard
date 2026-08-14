// Remediation access for the STIG dashboard backend.
//
// Deployed into the *remediation target* resource group so that the custom role
// and its assignment live at that resource group's scope. This avoids creating
// subscription-scoped resources from a resource-group-scoped deployment (which
// ARM does not permit) while keeping the grant tightly scoped: the backend's
// managed identity may only read machines and invoke RunCommand, and only
// within this one resource group.

@description('Base name used to derive the custom role name')
param baseName string

@description('Object ID of the backend App Service managed identity')
param principalId string

resource remediationRunCommandRole 'Microsoft.Authorization/roleDefinitions@2022-05-01-preview' = {
  name: guid(resourceGroup().id, 'runcommand-remediation-role')
  properties: {
    roleName: '${baseName}-runcommand-remediator-${uniqueString(resourceGroup().id)}'
    description: 'Least-privilege role for STIG remediation RunCommand execution only'
    type: 'CustomRole'
    assignableScopes: [
      resourceGroup().id
    ]
    permissions: [
      {
        actions: [
          'Microsoft.Compute/virtualMachines/read'
          'Microsoft.Compute/virtualMachines/runCommand/action'
          'Microsoft.HybridCompute/machines/read'
          'Microsoft.HybridCompute/machines/runCommand/action'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
  }
}

resource remediationRunCommandAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, principalId, 'runcommand-remediation-assignment')
  properties: {
    roleDefinitionId: remediationRunCommandRole.id
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

output roleDefinitionId string = remediationRunCommandRole.id
