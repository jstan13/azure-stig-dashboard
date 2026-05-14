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
import { PolicyConnector, PolicyComplianceResult } from './policyConnector';
import { DefenderConnector, DefenderFinding } from './defenderConnector';
import { ARMConnector, VMMetadata } from './armConnector';
import { ScanOptions } from './baseConnector';
import { ResourceGraphEntry } from './resourceGraphConnector';
import { AppDataSource, mockStore } from '../database/dataSource';
import { MachineEntity } from '../models/Machine';
import { ScanEntity } from '../models/Scan';
import { FindingEntity } from '../models/Finding';
import { ControlMappingEntity } from '../models/ControlMapping';
import { SubscriptionEntity } from '../models/Subscription';
import { ResourceGroupEntity } from '../models/ResourceGroup';
import { AuditLogEntity } from '../models/AuditLog';
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

      // ── Step 5: Persist Subscriptions / ResourceGroups / Machines ──────
      const armByResourceId = new Map<string, VMMetadata>();
      for (const m of armResult.data) armByResourceId.set(m.resourceId, m);

      const machines = await persistMachines(rgResult.data, armByResourceId);
      logger.info(`[Orchestrator] Upserted ${machines.length} machine(s)`);

      // ── Step 6: Normalize Policy + Defender results into Findings ──────
      const findingResults = await persistFindings(
        machines,
        policyResult.data,
        defenderResult.data,
      );
      logger.info(
        `[Orchestrator] Wrote ${findingResults.total} finding(s) (${findingResults.open} open)`,
      );

      // ── Step 7: Update machine compliance scores and lastScanDate ──────
      const completedAt = new Date();
      await updateMachineRollups(machines, completedAt);

      // ── Step 8: Persist a single Scan row per machine + a summary row ──
      const summaryScanId = await persistScans({
        scanId,
        machines,
        startedAt: new Date(start),
        completedAt,
        triggeredBy: options.resourceIds ? 'on-demand' : 'full-scan',
        scanType: options.resourceIds
          ? 'on-demand'
          : options.since
            ? 'incremental'
            : 'full',
        openCount: findingResults.open,
        totalControls: findingResults.total,
        compliantControls: findingResults.compliant,
      });

      // ── Step 9: Audit ──────────────────────────────────────────────────
      try {
        const auditRepo = AppDataSource.getRepository(AuditLogEntity);
        await auditRepo.save(
          auditRepo.create({
            action: 'scan.completed',
            actor: 'system',
            targetId: summaryScanId,
            targetType: 'scan',
            result: 'Success',
            details: {
              machineCount: machines.length,
              findingCount: findingResults.total,
              openCount: findingResults.open,
              durationMs: Date.now() - start,
            },
          }),
        );
      } catch (auditErr: any) {
        logger.warn('[Orchestrator] audit write failed:', auditErr?.message);
      }

      return {
        scanId: summaryScanId,
        machineCount: machines.length,
        findingCount: findingResults.total,
        openCount: findingResults.open,
        durationMs: Date.now() - start,
      };
    } catch (err: any) {
      logger.error('[Orchestrator] Scan failed:', err.message);
      throw err;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (real-mode persistence)
// ─────────────────────────────────────────────────────────────────────────────

interface FindingTotals {
  total: number;
  open: number;
  compliant: number;
  notApplicable: number;
}

async function persistMachines(
  rgEntries: ResourceGraphEntry[],
  armByResourceId: Map<string, VMMetadata>,
): Promise<MachineEntity[]> {
  const subRepo = AppDataSource.getRepository(SubscriptionEntity);
  const rgRepo = AppDataSource.getRepository(ResourceGroupEntity);
  const machineRepo = AppDataSource.getRepository(MachineEntity);

  // Pre-collect distinct subscription IDs / resource-group IDs to upsert
  const subIds = new Set<string>();
  const rgKeys = new Map<string, { id: string; name: string; subscriptionId: string; location?: string }>();
  for (const e of rgEntries) {
    subIds.add(e.subscriptionId);
    const rgId = `/subscriptions/${e.subscriptionId}/resourceGroups/${e.resourceGroupName}`;
    if (!rgKeys.has(rgId)) {
      rgKeys.set(rgId, {
        id: rgId,
        name: e.resourceGroupName,
        subscriptionId: e.subscriptionId,
        location: e.location,
      });
    }
  }

  // Upsert subscriptions
  for (const id of subIds) {
    const existing = await subRepo.findOne({ where: { id } });
    if (!existing) {
      await subRepo.save(
        subRepo.create({ id, displayName: id, isActive: true }),
      );
    }
  }

  // Upsert resource groups
  for (const rg of rgKeys.values()) {
    const existing = await rgRepo.findOne({ where: { id: rg.id } });
    if (existing) {
      if (rg.location && existing.location !== rg.location) {
        existing.location = rg.location;
        await rgRepo.save(existing);
      }
    } else {
      await rgRepo.save(rgRepo.create(rg));
    }
  }

  // Upsert machines (keyed by resourceId)
  const machines: MachineEntity[] = [];
  for (const e of rgEntries) {
    const arm = armByResourceId.get(e.id);
    const osType =
      arm?.osType ||
      e.properties?.storageProfile?.osDisk?.osType ||
      e.properties?.osName ||
      'Unknown';
    const osVersion =
      arm?.osVersion || e.properties?.osSku || undefined;

    const existing = await machineRepo.findOne({ where: { resourceId: e.id } });
    const row =
      existing ??
      machineRepo.create({
        resourceId: e.id,
        name: e.name,
        subscriptionId: e.subscriptionId,
        resourceGroupName: e.resourceGroupName,
        location: e.location,
        osType,
        osVersion,
        tags: e.tags,
        status: arm?.powerState || arm?.arcStatus || 'unknown',
      });

    // Always refresh mutable fields
    row.name = e.name;
    row.subscriptionId = e.subscriptionId;
    row.resourceGroupName = e.resourceGroupName;
    row.location = e.location ?? row.location;
    row.osType = osType;
    if (osVersion) row.osVersion = osVersion;
    row.tags = e.tags ?? row.tags;
    if (arm?.powerState || arm?.arcStatus) {
      row.status = (arm.powerState || arm.arcStatus) as string;
    }

    machines.push(await machineRepo.save(row));
  }

  return machines;
}

async function persistFindings(
  machines: MachineEntity[],
  policyResults: PolicyComplianceResult[],
  defenderResults: DefenderFinding[],
): Promise<FindingTotals> {
  const findingRepo = AppDataSource.getRepository(FindingEntity);
  const mappingRepo = AppDataSource.getRepository(ControlMappingEntity);

  const machineByResourceId = new Map(machines.map((m) => [m.resourceId, m]));

  let total = 0;
  let open = 0;
  let compliant = 0;
  let notApplicable = 0;

  // ── Policy → Finding ─────────────────────────────────────────────────────
  for (const p of policyResults) {
    const machine = machineByResourceId.get(p.resourceId);
    if (!machine) continue;

    // Look up STIG control(s) mapped to this policy definition.
    const mappings = await mappingRepo.find({
      where: { sourceType: 'azure-policy', sourceId: p.policyDefinitionId },
    });
    if (!mappings.length) continue;

    for (const mapping of mappings) {
      const status = mapPolicyState(p.complianceState);
      const result = await upsertFinding(findingRepo, {
        machineId: machine.id,
        controlId: mapping.controlId,
        status,
        sourceType: 'azure-policy',
        evidence: {
          policyDefinitionId: p.policyDefinitionId,
          policyDefinitionName: p.policyDefinitionName,
          complianceState: p.complianceState,
          evaluatedAt: p.evaluatedAt,
          reason: p.reason,
        },
      });
      total++;
      if (result.status === 'open') open++;
      else if (result.status === 'not_a_finding') compliant++;
      else if (result.status === 'not_applicable') notApplicable++;
    }
  }

  // ── Defender → Finding ───────────────────────────────────────────────────
  for (const d of defenderResults) {
    const machine = machineByResourceId.get(d.resourceId);
    if (!machine) continue;

    // Mappings keyed by defender assessment ID OR assessment name
    const sourceCandidates = [d.id, d.assessmentName, d.defenderRuleId].filter(
      (x): x is string => !!x,
    );
    const mappings = await mappingRepo.find({
      where: sourceCandidates.map((sourceId) => ({
        sourceType: 'defender',
        sourceId,
      })),
    });
    if (!mappings.length) continue;

    for (const mapping of mappings) {
      const status = mapDefenderState(d.status);
      const result = await upsertFinding(findingRepo, {
        machineId: machine.id,
        controlId: mapping.controlId,
        status,
        severity: (d.severity || 'medium').toLowerCase(),
        sourceType: 'defender',
        evidence: {
          assessmentId: d.id,
          assessmentName: d.assessmentName,
          displayName: d.displayName,
          status: d.status,
          severity: d.severity,
          remediation: d.remediationDescription,
        },
      });
      total++;
      if (result.status === 'open') open++;
      else if (result.status === 'not_a_finding') compliant++;
      else if (result.status === 'not_applicable') notApplicable++;
    }
  }

  return { total, open, compliant, notApplicable };
}

async function upsertFinding(
  repo: import('typeorm').Repository<FindingEntity>,
  data: {
    machineId: string;
    controlId: string;
    status: string;
    severity?: string;
    sourceType: string;
    evidence: Record<string, any>;
  },
): Promise<FindingEntity> {
  const existing = await repo.findOne({
    where: { machineId: data.machineId, controlId: data.controlId },
  });
  if (existing) {
    existing.status = data.status;
    if (data.severity) existing.severity = data.severity;
    existing.sourceType = data.sourceType;
    existing.evidence = data.evidence;
    return repo.save(existing);
  }
  const row = repo.create({
    machineId: data.machineId,
    controlId: data.controlId,
    status: data.status,
    severity: data.severity ?? 'medium',
    sourceType: data.sourceType,
    evidence: data.evidence,
  });
  return repo.save(row);
}

async function updateMachineRollups(
  machines: MachineEntity[],
  completedAt: Date,
): Promise<void> {
  const findingRepo = AppDataSource.getRepository(FindingEntity);
  const machineRepo = AppDataSource.getRepository(MachineEntity);

  for (const m of machines) {
    const findings = await findingRepo.find({ where: { machineId: m.id } });
    const applicable = findings.filter((f) => f.status !== 'not_applicable');
    const passing = findings.filter((f) => f.status === 'not_a_finding');
    m.complianceScore = applicable.length
      ? Math.round((passing.length / applicable.length) * 100)
      : 0;
    m.lastScanDate = completedAt;
    await machineRepo.save(m);
  }
}

interface PersistScansArgs {
  scanId: string;
  machines: MachineEntity[];
  startedAt: Date;
  completedAt: Date;
  triggeredBy: string;
  scanType: string;
  openCount: number;
  totalControls: number;
  compliantControls: number;
}

async function persistScans(args: PersistScansArgs): Promise<string> {
  const scanRepo = AppDataSource.getRepository(ScanEntity);
  const findingRepo = AppDataSource.getRepository(FindingEntity);

  // Write a Scan row per machine so the per-machine "last scan" UI works.
  for (const m of args.machines) {
    const findings = await findingRepo.find({ where: { machineId: m.id } });
    const open = findings.filter((f) => f.status === 'open').length;
    const compliant = findings.filter((f) => f.status === 'not_a_finding').length;

    const row = scanRepo.create({
      machineId: m.id,
      machineName: m.name,
      subscriptionId: m.subscriptionId,
      resourceGroupName: m.resourceGroupName,
      triggeredBy: args.triggeredBy,
      scanType: args.scanType,
      status: 'completed',
      startedAt: args.startedAt,
      completedAt: args.completedAt,
      totalControls: findings.length,
      openFindings: open,
      compliantControls: compliant,
    });
    await scanRepo.save(row);
  }

  // Summary row with the synthetic orchestrator-level scanId so the API caller
  // gets a single ID to reference (matches the pre-existing mock behaviour).
  const summary = scanRepo.create({
    id: args.scanId,
    machineId: args.machines[0]?.id ?? args.scanId,
    machineName: 'all-machines',
    subscriptionId: args.machines[0]?.subscriptionId,
    triggeredBy: args.triggeredBy,
    scanType: args.scanType,
    status: 'completed',
    startedAt: args.startedAt,
    completedAt: args.completedAt,
    totalControls: args.totalControls,
    openFindings: args.openCount,
    compliantControls: args.compliantControls,
  });
  await scanRepo.save(summary);
  return summary.id;
}

function mapPolicyState(state: string): string {
  switch (state) {
    case 'Compliant':
      return 'not_a_finding';
    case 'Exempt':
      return 'not_applicable';
    case 'NonCompliant':
      return 'open';
    default:
      return 'not_reviewed';
  }
}

function mapDefenderState(state: string): string {
  switch (state) {
    case 'Healthy':
      return 'not_a_finding';
    case 'NotApplicable':
      return 'not_applicable';
    case 'Unhealthy':
      return 'open';
    default:
      return 'not_reviewed';
  }
}
