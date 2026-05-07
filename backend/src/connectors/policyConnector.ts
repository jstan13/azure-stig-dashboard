/**
 * Azure Policy Connector
 *
 * Retrieves policy compliance states for resources.
 * Maps policy definition IDs to STIG control IDs via the control mapping table.
 *
 * Required permissions: Reader + Policy Reader on target subscriptions.
 * SDK: @azure/arm-policy
 */

import { PolicyClient } from '@azure/arm-policy';
import { DefaultAzureCredential } from '@azure/identity';
import { BaseConnector, ConnectorResult, ScanOptions } from './baseConnector';
import { logger } from '../utils/logger';
import { mockStore } from '../database/dataSource';

export interface PolicyComplianceResult {
  resourceId: string;
  policyDefinitionId: string;
  policyDefinitionName?: string;
  complianceState: 'Compliant' | 'NonCompliant' | 'Unknown' | 'Exempt' | 'Conflict';
  subscriptionId: string;
  resourceGroupName: string;
  evaluatedAt?: Date;
  reason?: string;
}

export class PolicyConnector extends BaseConnector {
  private clients: Map<string, PolicyClient> = new Map();

  private getClient(subscriptionId: string): PolicyClient {
    if (!this.clients.has(subscriptionId)) {
      this.clients.set(
        subscriptionId,
        new PolicyClient(new DefaultAzureCredential(), subscriptionId, require('./azureClientOptions').azureClientOptions()),
      );
    }
    return this.clients.get(subscriptionId)!;
  }

  async scan(options: ScanOptions = {}): Promise<ConnectorResult<PolicyComplianceResult>> {
    const scannedAt = new Date();

    if (this.mockMode) {
      logger.info('[Policy] MOCK_MODE — returning seeded policy states');

      // Derive mock policy results from the mock findings
      const mockResults: PolicyComplianceResult[] = mockStore.findings
        .filter((f: any) => f.sourceType === 'azure-policy')
        .map((f: any) => {
          const control = mockStore.controls.find((c: any) => c.id === f.controlId);
          const machine = mockStore.machines.find((m: any) => m.id === f.machineId);
          return {
            resourceId: machine?.resourceId || `mock-resource-${f.machineId}`,
            policyDefinitionId: control?.azurePolicyId || '/providers/Microsoft.Authorization/policyDefinitions/mock',
            policyDefinitionName: control?.title || 'Mock Policy',
            complianceState: f.status === 'not_a_finding' ? 'Compliant' : f.status === 'not_applicable' ? 'Exempt' : 'NonCompliant',
            subscriptionId: machine?.subscriptionId || 'mock-sub-001',
            resourceGroupName: machine?.resourceGroupName || 'rg-demo',
            evaluatedAt: new Date(),
          };
        });

      return { data: mockResults, scannedAt, source: 'policy-mock' };
    }

    const subscriptions = options.subscriptionIds || [process.env.AZURE_SUBSCRIPTION_ID || ''];
    const results: PolicyComplianceResult[] = [];

    for (const subId of subscriptions) {
      try {
        logger.info(`[Policy] Scanning subscription ${subId}`);
        const client = this.getClient(subId);

        const filter = options.resourceGroupNames?.length
          ? `ResourceGroupName eq '${options.resourceGroupNames[0]}'`
          : undefined;

        for await (const state of client.policyStates.listQueryResultsForSubscription(
          'latest',
          subId,
          { queryOptions: { filter } },
        )) {
          results.push({
            resourceId: state.resourceId || '',
            policyDefinitionId: state.policyDefinitionId || '',
            policyDefinitionName: state.policyDefinitionName,
            complianceState: (state.complianceState as any) || 'Unknown',
            subscriptionId: subId,
            resourceGroupName: state.resourceGroup || '',
            evaluatedAt: state.timestamp ? new Date(state.timestamp) : undefined,
          });
        }

        logger.info(`[Policy] Retrieved ${results.length} states from ${subId}`);
      } catch (err: any) {
        logger.error(`[Policy] Failed to scan subscription ${subId}:`, err.message);
      }
    }

    return { data: results, scannedAt, source: 'azure-policy' };
  }
}
