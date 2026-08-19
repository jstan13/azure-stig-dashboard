/**
 * Microsoft Defender for Cloud (Security Center) Connector
 *
 * Fetches CSPM assessments / security recommendations that map to STIG controls.
 *
 * Required permissions: Security Reader on target subscriptions.
 * SDK: @azure/arm-security
 */

import { SecurityCenter } from '@azure/arm-security';
import { DefaultAzureCredential } from '@azure/identity';
import { BaseConnector, ConnectorResult, ScanOptions } from './baseConnector';
import { azureClientOptions } from './azureClientOptions';
import { logger } from '../utils/logger';
import { mockStore } from '../database/dataSource';

export interface DefenderFinding {
  id: string;
  resourceId: string;
  assessmentName: string;
  displayName: string;
  status: 'Healthy' | 'Unhealthy' | 'NotApplicable' | 'Unknown';
  severity: 'High' | 'Medium' | 'Low' | 'Informational';
  description?: string;
  remediationDescription?: string;
  subscriptionId: string;
  defenderRuleId?: string; // e.g. MDFC-001
}

export class DefenderConnector extends BaseConnector {
  private clients: Map<string, SecurityCenter> = new Map();

  private getClient(subscriptionId: string): SecurityCenter {
    if (!this.clients.has(subscriptionId)) {
      this.clients.set(
        subscriptionId,
        new SecurityCenter(new DefaultAzureCredential(), subscriptionId, azureClientOptions()),
      );
    }
    return this.clients.get(subscriptionId)!;
  }

  async scan(options: ScanOptions = {}): Promise<ConnectorResult<DefenderFinding>> {
    const scannedAt = new Date();

    if (this.mockMode) {
      logger.info('[Defender] MOCK_MODE — returning seeded Defender findings');

      const mockFindings: DefenderFinding[] = mockStore.controls
        .filter((c: any) => c.defenderRuleId)
        .flatMap((c: any) =>
          mockStore.machines.map((m: any) => {
            const finding = mockStore.findings.find(
              (f: any) => f.machineId === m.id && f.controlId === c.id,
            );
            return {
              id: `defender-${m.id}-${c.id}`,
              resourceId: m.resourceId,
              assessmentName: c.defenderRuleId,
              displayName: c.title,
              status: (finding?.status === 'not_a_finding' ? 'Healthy' : finding?.status === 'not_applicable' ? 'NotApplicable' : 'Unhealthy') as any,
              severity: c.severity.charAt(0).toUpperCase() + c.severity.slice(1),
              description: c.description,
              remediationDescription: c.fixText,
              subscriptionId: m.subscriptionId,
              defenderRuleId: c.defenderRuleId,
            };
          }),
        );

      return { data: mockFindings, scannedAt, source: 'defender-mock' };
    }

    const subscriptions = options.subscriptionIds || [process.env.AZURE_SUBSCRIPTION_ID || ''];
    const results: DefenderFinding[] = [];

    for (const subId of subscriptions) {
      try {
        logger.info(`[Defender] Scanning subscription ${subId}`);
        const client = this.getClient(subId);

        for await (const assessment of client.assessments.list('/subscriptions/' + subId)) {
          const status = assessment.status?.code;
          const meta = assessment.metadata;
          results.push({
            id: assessment.id || '',
            resourceId: (assessment.resourceDetails as any)?.id || '',
            assessmentName: assessment.name || '',
            displayName: meta?.displayName || '',
            status: (status as any) || 'Unknown',
            severity: (meta?.severity as any) || 'Medium',
            description: meta?.description,
            remediationDescription: meta?.remediationDescription,
            subscriptionId: subId,
          });
        }

        logger.info(`[Defender] Retrieved ${results.length} assessments from ${subId}`);
      } catch (err: any) {
        logger.error(`[Defender] Failed for subscription ${subId}:`, err.message);
      }
    }

    return { data: results, scannedAt, source: 'defender' };
  }
}
