/**
 * Scan Orchestrator
 *
 * Coordinates all Azure connectors to perform a full or incremental scan.
 * Normalises raw Azure data into the internal data model and persists results.
 *
 * Flow:
 *   1. Discover VMs via ResourceGraph
 *   2. Enrich metadata via ARM
 *   3. Pull policy compliance states via Policy connector
 *   4. Pull Defender assessments via Defender connector
 *   5. Map findings to STIG controls via control mapping table
 *   6. Compute per-machine compliance scores
 *   7. Persist findings + scan record
 */

import { ResourceGraphConnector } from './resourceGraphConnector';
import { PolicyConnector } from './policyConnector';
import { DefenderConnector } from './defenderConnector';
import { ARMConnector } from './armConnector';
import { ScanOptions } from './baseConnector';
import { mockStore } from '../database/dataSource';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';

const MOCK_MODE = process.env.MOCK_MODE === 'true';

export interface OrchestrationResult {
  scanId: string;
  machineCount: number;
  findingCount: number;
  openCount: number;
  durationMs: number;
}

export class ScanOrchestrator {
  private resourceGraph = new ResourceGraphConnector();
  private policy = new PolicyConnector();
  private defender = new DefenderConnector();
  private arm = new ARMConnector();

  async runScan(options: ScanOptions = {}): Promise<OrchestrationResult> {
    const start = Date.now();
    const scanId = uuidv4();
    logger.info(`[Orchestrator] Scan ${scanId} started`);

    if (MOCK_MODE) {
      // In mock mode the data is already seeded — just create a fresh scan record
      const openCount = mockStore.findings.filter((f: any) => f.status === 'open').length;
      const scanRecord = {
        id: scanId,
        machineId: options.resourceIds?.[0] || mockStore.machines[0]?.id,
        machineName: 'all-machines',
        subscriptionId: options.subscriptionIds?.[0] || 'mock-sub-001',
        triggeredBy: options.resourceIds ? 'on-demand' : 'full-scan',
        scanType: options.resourceIds ? 'on-demand' : options.since ? 'incremental' : 'full',
        status: 'completed',
        startedAt: new Date(start).toISOString(),
        completedAt: new Date().toISOString(),
        totalControls: mockStore.controls.length,
        openFindings: openCount,
        compliantControls: mockStore.findings.filter((f: any) => f.status === 'not_a_finding').length,
      };
      mockStore.scans.unshift(scanRecord);
      mockStore.auditLogs.unshift({
        id: uuidv4(),
        action: 'scan.completed',
        actor: 'system',
        targetId: scanId,
        targetType: 'scan',
        timestamp: new Date().toISOString(),
        details: { scanType: scanRecord.scanType, openFindings: openCount },
      });

      return {
        scanId,
        machineCount: mockStore.machines.length,
        findingCount: mockStore.findings.length,
        openCount,
        durationMs: Date.now() - start,
      };
    }

    // ── Real Azure scan ────────────────────────────────────────────────────
    try {
      // Step 1: Discover VMs
      const rgResult = await this.resourceGraph.scan(options);
      logger.info(`[Orchestrator] Discovered ${rgResult.data.length} VMs`);

      // Step 2: Enrich with ARM metadata
      const armResult = await this.arm.scan(options);

      // Step 3: Policy compliance
      const policyResult = await this.policy.scan(options);

      // Step 4: Defender assessments
      const defenderResult = await this.defender.scan(options);

      // TODO: persist results to database using TypeORM
      // This is where you would upsert Machine, Finding, Scan records.
      // Requires database to be configured (set MOCK_MODE=false and provide DB creds).
      logger.info('[Orchestrator] TODO: persist results to database');

      return {
        scanId,
        machineCount: rgResult.data.length,
        findingCount: policyResult.data.length + defenderResult.data.length,
        openCount: policyResult.data.filter((r) => r.complianceState === 'NonCompliant').length,
        durationMs: Date.now() - start,
      };
    } catch (err: any) {
      logger.error('[Orchestrator] Scan failed:', err.message);
      throw err;
    }
  }
}
