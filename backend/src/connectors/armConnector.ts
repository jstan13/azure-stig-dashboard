/**
 * Azure Resource Manager (ARM) Connector
 *
 * Retrieves VM instance metadata, extension status, and OS configuration
 * via the Azure Compute Management SDK for native Azure VMs, and the
 * Azure HybridCompute Management SDK for Arc-connected machines
 * (on-premises servers, other clouds, or edge devices enrolled in Azure Arc).
 *
 * Required permissions: Reader on target subscriptions.
 * SDKs: @azure/arm-compute, @azure/arm-hybridcompute
 */

import { ComputeManagementClient } from '@azure/arm-compute';
import { HybridComputeManagementClient } from '@azure/arm-hybridcompute';
import { DefaultAzureCredential } from '@azure/identity';
import { BaseConnector, ConnectorResult, ScanOptions } from './baseConnector';
import { logger } from '../utils/logger';
import { mockStore } from '../database/dataSource';

export interface VMMetadata {
  resourceId: string;
  name: string;
  subscriptionId: string;
  resourceGroupName: string;
  location: string;
  osType: string;
  osVersion?: string;
  vmSize?: string;
  provisioningState?: string;
  powerState?: string;
  extensions?: VMExtension[];
  tags?: Record<string, string>;
  /** true when the machine is managed via Azure Arc (Microsoft.HybridCompute/machines) */
  isArcConnected: boolean;
  /** Arc agent version — populated only for Arc-connected machines */
  arcAgentVersion?: string;
  /** Arc connectivity status — populated only for Arc-connected machines */
  arcStatus?: string;
}

export interface VMExtension {
  name: string;
  publisher: string;
  type: string;
  provisioningState: string;
  // Relevant STIG-related extensions: MicrosoftMonitoringAgent, AzurePolicyforWindows, etc.
}

export class ARMConnector extends BaseConnector {
  private clients: Map<string, ComputeManagementClient> = new Map();
  private hybridClients: Map<string, HybridComputeManagementClient> = new Map();

  private getClient(subscriptionId: string): ComputeManagementClient {
    if (!this.clients.has(subscriptionId)) {
      this.clients.set(
        subscriptionId,
        new ComputeManagementClient(new DefaultAzureCredential(), subscriptionId, require('./azureClientOptions').azureClientOptions()),
      );
    }
    return this.clients.get(subscriptionId)!;
  }

  private getHybridClient(subscriptionId: string): HybridComputeManagementClient {
    if (!this.hybridClients.has(subscriptionId)) {
      this.hybridClients.set(
        subscriptionId,
        new HybridComputeManagementClient(new DefaultAzureCredential(), subscriptionId, require('./azureClientOptions').azureClientOptions()),
      );
    }
    return this.hybridClients.get(subscriptionId)!;
  }

  async scan(options: ScanOptions = {}): Promise<ConnectorResult<VMMetadata>> {
    const scannedAt = new Date();

    if (this.mockMode) {
      logger.info('[ARM] MOCK_MODE — returning seeded VM metadata (Azure VMs + Arc machines)');
      return {
        data: mockStore.machines.map((m: any) => {
          const isArc = m.resourceId.includes('HybridCompute');
          return {
            resourceId: m.resourceId,
            name: m.name,
            subscriptionId: m.subscriptionId,
            resourceGroupName: m.resourceGroupName,
            location: m.location,
            osType: m.osType,
            osVersion: m.osVersion,
            vmSize: isArc ? undefined : 'Standard_D2s_v3',
            provisioningState: 'Succeeded',
            powerState: 'running',
            isArcConnected: isArc,
            arcAgentVersion: isArc ? m.arcAgentVersion : undefined,
            arcStatus: isArc ? 'Connected' : undefined,
            extensions: isArc
              ? [
                  { name: 'AzurePolicyforLinux', publisher: 'Microsoft.GuestConfiguration', type: 'ConfigurationforLinux', provisioningState: 'Succeeded' },
                  { name: 'MicrosoftMonitoringAgent', publisher: 'Microsoft.EnterpriseCloud.Monitoring', type: 'OmsAgentForLinux', provisioningState: 'Succeeded' },
                ]
              : [
                  { name: 'AzurePolicyforWindows', publisher: 'Microsoft.GuestConfiguration', type: 'ConfigurationforWindows', provisioningState: 'Succeeded' },
                  { name: 'MicrosoftMonitoringAgent', publisher: 'Microsoft.EnterpriseCloud.Monitoring', type: 'MicrosoftMonitoringAgent', provisioningState: 'Succeeded' },
                ],
            tags: m.tags,
          };
        }),
        scannedAt,
        source: 'arm-mock',
      };
    }

    const subscriptions = options.subscriptionIds || [process.env.AZURE_SUBSCRIPTION_ID || ''];
    const results: VMMetadata[] = [];

    for (const subId of subscriptions) {
      try {
        logger.info(`[ARM] Scanning subscription ${subId}`);
        const client = this.getClient(subId);

        const vmIterator = options.resourceGroupNames?.length
          ? client.virtualMachines.list(options.resourceGroupNames[0])
          : client.virtualMachines.listAll();

        for await (const vm of vmIterator) {
          const rgName = vm.id?.split('/resourceGroups/')[1]?.split('/')[0] || '';

          // Optionally fetch extensions
          let extensions: VMExtension[] = [];
          try {
            for await (const ext of client.virtualMachineExtensions.list(rgName, vm.name || '')) {
              extensions.push({
                name: ext.name || '',
                publisher: ext.publisher || '',
                type: ext.typePropertiesType || '',
                provisioningState: ext.provisioningState || 'Unknown',
              });
            }
          } catch {
            // Extensions fetch is best-effort
          }

          results.push({
            resourceId: vm.id || '',
            name: vm.name || '',
            subscriptionId: subId,
            resourceGroupName: rgName,
            location: vm.location || '',
            osType: vm.storageProfile?.osDisk?.osType || 'Unknown',
            osVersion: vm.storageProfile?.imageReference?.exactVersion,
            vmSize: vm.hardwareProfile?.vmSize,
            provisioningState: vm.provisioningState,
            isArcConnected: false,
            extensions,
            tags: vm.tags as any,
          });
        }

        logger.info(`[ARM] Retrieved ${results.length} VMs from ${subId}`);

        // ── Azure Arc-connected machines ────────────────────────────────────
        // Microsoft.HybridCompute/machines represent on-premises servers,
        // edge devices, and workloads in other clouds enrolled via Azure Arc.
        // They surface in Azure Policy compliance and Defender for Cloud
        // assessments, so they must be included in the STIG inventory.
        try {
          const hybridClient = this.getHybridClient(subId);
          const arcIterator = hybridClient.machines.listBySubscription();
          for await (const machine of arcIterator) {
            const rgName = machine.id?.split('/resourceGroups/')[1]?.split('/')[0] || '';

            let extensions: VMExtension[] = [];
            try {
              for await (const ext of hybridClient.machineExtensions.list(rgName, machine.name || '')) {
                extensions.push({
                  name: ext.name || '',
                  publisher: ext.publisher || '',
                  type: ext.typePropertiesType || '',
                  provisioningState: ext.provisioningState || 'Unknown',
                });
              }
            } catch {
              // Extension fetch is best-effort
            }

            results.push({
              resourceId: machine.id || '',
              name: machine.name || '',
              subscriptionId: subId,
              resourceGroupName: rgName,
              location: machine.location || '',
              osType: machine.osName || 'Unknown',
              osVersion: machine.osSku,
              provisioningState: machine.provisioningState,
              isArcConnected: true,
              arcAgentVersion: machine.agentVersion,
              arcStatus: machine.status,
              extensions,
              tags: machine.tags as any,
            });
          }
          logger.info(`[ARM] Retrieved ${results.length} total machines (VMs + Arc) from ${subId}`);
        } catch (err: any) {
          logger.warn(`[ARM] HybridCompute scan failed for ${subId} — Arc machines may be missing: ${err.message}`);
        }
      } catch (err: any) {
        logger.error(`[ARM] Failed for subscription ${subId}:`, err.message);
      }
    }

    return { data: results, scannedAt, source: 'arm' };
  }
}
