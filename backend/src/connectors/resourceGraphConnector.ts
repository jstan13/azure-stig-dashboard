/**
 * Azure Resource Graph Connector
 *
 * Queries Azure Resource Graph for VM inventory across one or more subscriptions.
 * Includes both native Azure VMs (Microsoft.Compute/virtualMachines) and
 * Azure Arc-connected machines (Microsoft.HybridCompute/machines) so that
 * on-premises and multi-cloud endpoints enrolled via Azure Arc are tracked
 * alongside cloud-native resources.
 *
 * Required permissions: Reader on each subscription.
 * SDK: @azure/arm-resourcegraph
 */

import { ResourceGraphClient } from '@azure/arm-resourcegraph';
import { DefaultAzureCredential } from '@azure/identity';
import { BaseConnector, ConnectorResult, ScanOptions } from './baseConnector';
import { azureClientOptions } from './azureClientOptions';
import { logger } from '../utils/logger';
import { mockStore } from '../database/dataSource';

export interface ResourceGraphEntry {
  id: string;
  name: string;
  type: string;
  location: string;
  subscriptionId: string;
  resourceGroupName: string;
  properties?: Record<string, any>;
  tags?: Record<string, string>;
}

const VM_QUERY = `
Resources
| where type =~ 'Microsoft.Compute/virtualMachines'
    or type =~ 'Microsoft.HybridCompute/machines'
| project
    id,
    name,
    type,
    location,
    subscriptionId,
    resourceGroupName = resourceGroup,
    properties,
    tags
| order by name asc
`;

// Convenience predicate re-used in other queries
const ALL_MACHINE_TYPES = `type =~ 'Microsoft.Compute/virtualMachines' or type =~ 'Microsoft.HybridCompute/machines'`;

const VM_INCREMENTAL_QUERY = (since: string) => `
ResourceChanges
| where changeType in ('Create', 'Update')
| where resourceChangeDetails.targetResourceType =~ 'Microsoft.Compute/virtualMachines'
    or resourceChangeDetails.targetResourceType =~ 'Microsoft.HybridCompute/machines'
| where changeTime > datetime('${since}')
| project resourceId, changeType, changeTime
`;

export class ResourceGraphConnector extends BaseConnector {
  private client?: ResourceGraphClient;

  private getClient(): ResourceGraphClient {
    if (!this.client) {
      this.client = new ResourceGraphClient(new DefaultAzureCredential(), azureClientOptions());
    }
    return this.client;
  }

  async scan(options: ScanOptions = {}): Promise<ConnectorResult<ResourceGraphEntry>> {
    const scannedAt = new Date();

    if (this.mockMode) {
      logger.info('[ResourceGraph] MOCK_MODE — returning seeded VM inventory (Azure VMs + Arc machines)');
      return {
        data: mockStore.machines.map((m: any) => ({
          id: m.resourceId,
          name: m.name,
          // Derive the resource type from the resourceId so Arc machines are
          // represented with the correct type (Microsoft.HybridCompute/machines)
          type: m.resourceId.includes('HybridCompute')
            ? 'Microsoft.HybridCompute/machines'
            : 'Microsoft.Compute/virtualMachines',
          location: m.location,
          subscriptionId: m.subscriptionId,
          resourceGroupName: m.resourceGroupName,
          tags: m.tags,
          properties: m.resourceId.includes('HybridCompute')
            ? { osName: m.osType, osSku: m.osVersion, agentVersion: m.arcAgentVersion, status: m.status }
            : { storageProfile: { osDisk: { osType: m.osType } } },
        })),
        scannedAt,
        source: 'resource-graph-mock',
      };
    }

    try {
      const subscriptions = options.subscriptionIds || [process.env.AZURE_SUBSCRIPTION_ID || ''];
      const query = options.since
        ? VM_INCREMENTAL_QUERY(options.since.toISOString())
        : VM_QUERY;

      logger.info(`[ResourceGraph] Querying ${subscriptions.length} subscription(s)`);

      const results: ResourceGraphEntry[] = [];
      let skipToken: string | undefined;

      do {
        const response = await this.getClient().resources({
          subscriptions,
          query,
          options: {
            resultFormat: 'objectArray',
            ...(skipToken ? { skipToken } : {}),
            top: options.maxResults || 1000,
          },
        });

        const rows = (response.data as any[]) || [];
        for (const row of rows) {
          results.push({
            id: row.id,
            name: row.name,
            type: row.type,
            location: row.location,
            subscriptionId: row.subscriptionId,
            resourceGroupName: row.resourceGroupName,
            properties: row.properties,
            tags: row.tags,
          });
        }

        skipToken = response.skipToken;

        logger.debug(`[ResourceGraph] Fetched ${rows.length} rows (total so far: ${results.length})`);
      } while (skipToken);

      return { data: results, scannedAt, source: 'resource-graph' };
    } catch (err: any) {
      logger.error('[ResourceGraph] Scan failed', err);
      throw err;
    }
  }
}
