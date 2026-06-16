/**
 * SCAP / ARF Result Parser
 *
 * Parses an XCCDF results-ARF XML document produced by oscap xccdf eval
 * and upserts Finding records into the database.
 *
 * ARF schema: https://scap.nist.gov/specifications/arf/
 * XCCDF result: rule-result element with idref + result child
 *
 * Result → Finding status mapping:
 *   pass               → not_a_finding
 *   fail               → open
 *   notapplicable      → not_applicable
 *   notchecked         → not_reviewed
 *   notselected        → not_reviewed
 *   informational      → not_reviewed
 *   error              → not_reviewed
 */

import { parseStringPromise } from 'xml2js';
import { DataSource, Repository } from 'typeorm';
import { FindingEntity } from '../models/Finding';
import { MachineEntity } from '../models/Machine';
import { ScanEntity } from '../models/Scan';
import { ControlEntity } from '../models/Control';
import { ComplianceHistoryEntity } from '../models/ComplianceHistory';
import { shouldReplaceFinding } from './sourceFidelity';
import { logger } from '../utils/logger';

type FindingStatus = 'open' | 'not_a_finding' | 'not_applicable' | 'not_reviewed';

interface ScapRuleResult {
  ruleId: string;
  result: FindingStatus;
  severity?: string;
  message?: string;
  checkOutput?: string;
}

const RESULT_MAP: Record<string, FindingStatus> = {
  pass:          'not_a_finding',
  fail:          'open',
  notapplicable: 'not_applicable',
  notchecked:    'not_reviewed',
  notselected:   'not_reviewed',
  informational: 'not_reviewed',
  error:         'not_reviewed',
  unknown:       'not_reviewed',
  fixed:         'not_a_finding',
};

export async function parseScapResults(
  arfXml: string,
  machine: MachineEntity,
  scan: ScanEntity,
  dataSource: DataSource,
): Promise<void> {
  const ruleResults = await extractRuleResults(arfXml);
  if (!ruleResults.length) {
    logger.warn(`[ScapParser] No rule-results found in ARF for ${machine.name}`);
    return;
  }

  logger.info(`[ScapParser] Processing ${ruleResults.length} rule results for ${machine.name}`);

  const findingRepo = dataSource.getRepository(FindingEntity);
  const controlRepo = dataSource.getRepository(ControlEntity);

  let open = 0, naFinding = 0, notApplicable = 0, notReviewed = 0;

  for (const rr of ruleResults) {
    // ruleId format: xccdf_mil.disa.stig_rule_SV-257809r925315_rule
    // We map to vulnId: extract "V-257809" from the rule suffix
    const vulnId = extractVulnId(rr.ruleId);
    if (!vulnId) continue;

    // Find the control by vulnId
    const control = await controlRepo.findOne({ where: { vulnId } });
    if (!control) continue;

    await upsertFinding(findingRepo, {
      machineId:      machine.id,
      controlId:      control.id,
      scanId:         scan.id,
      status:         rr.result,
      severity:       rr.severity ?? control.severity ?? 'medium',
      findingDetails: rr.checkOutput ?? '',
      comments:       rr.message ?? '',
      sourceType:     'openscap',
    });

    switch (rr.result) {
      case 'open':           open++;           break;
      case 'not_a_finding':  naFinding++;      break;
      case 'not_applicable': notApplicable++;  break;
      case 'not_reviewed':   notReviewed++;    break;
    }
  }

  // Write compliance history snapshot
  const totalControls = ruleResults.length;
  const score = totalControls > 0
    ? Math.round(((naFinding + notApplicable) / totalControls) * 1000) / 10
    : 0;

  await recordComplianceSnapshot(dataSource, machine.id, scan.id, {
    score, totalControls, openFindings: open,
    catIOpen: 0, catIIOpen: 0, catIIIOpen: 0,
    resolved: naFinding, notApplicable, notReviewed,
  });

  logger.info(`[ScapParser] ${machine.name}: score=${score}% open=${open} pass=${naFinding} na=${notApplicable} nr=${notReviewed}`);
}

// ─── XML parsing ─────────────────────────────────────────────────────────────

async function extractRuleResults(arfXml: string): Promise<ScapRuleResult[]> {
  const doc = await parseStringPromise(arfXml, { explicitArray: true, ignoreAttrs: false });

  // Navigate ARF → TestResult → rule-result
  const arf         = doc['arf:asset-report-collection'] ?? doc;
  const reports     = findDeep(arf, 'arf:reports') ?? findDeep(arf, 'reports');
  const report      = Array.isArray(reports) ? reports[0] : reports;
  const content     = findDeep(report, 'arf:content') ?? findDeep(report, 'content');
  const testResult  = findDeep(content, 'TestResult') ?? findDeep(content, 'cdf:TestResult') ?? findDeep(arf, 'TestResult');

  const ruleResultNodes = findDeep(testResult, 'rule-result') ?? findDeep(testResult, 'cdf:rule-result') ?? [];
  const nodes = Array.isArray(ruleResultNodes) ? ruleResultNodes : [ruleResultNodes];

  return nodes.map((n: any) => {
    const attrs = n.$ ?? {};
    const resultVal = textOf(n['result'] ?? n['cdf:result']);
    return {
      ruleId:      attrs.idref ?? '',
      result:      RESULT_MAP[resultVal?.toLowerCase() ?? ''] ?? 'not_reviewed',
      severity:    attrs.severity,
      message:     textOf(n['message'] ?? n['cdf:message']),
      checkOutput: textOf(n['check'] ?? n['cdf:check']),
    };
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findDeep(obj: any, key: string): any {
  if (!obj || typeof obj !== 'object') return undefined;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    const found = findDeep(v, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function textOf(v: any): string {
  if (!v) return '';
  if (Array.isArray(v)) return textOf(v[0]);
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return v._ ?? textOf(v['$']);
  return String(v);
}

function extractVulnId(ruleId: string): string | null {
  // e.g. xccdf_mil.disa.stig_rule_SV-257809r925315_rule → V-257809
  const m = ruleId.match(/SV-(\d+)/);
  if (m) return `V-${m[1]}`;
  // also handle V-\d+ directly
  const m2 = ruleId.match(/V-(\d+)/);
  if (m2) return `V-${m2[1]}`;
  return null;
}

async function upsertFinding(
  repo: Repository<FindingEntity>,
  data: {
    machineId: string; controlId: string; scanId: string;
    status: FindingStatus; severity: string;
    findingDetails: string; comments: string; sourceType: string;
  },
): Promise<void> {
  const existing = await repo.findOne({
    where: { machineId: data.machineId, controlId: data.controlId },
  });
  if (existing) {
    // Best-source precedence: an in-guest SCAP result must not downgrade a
    // higher-fidelity result or a human reviewer's decision already on record.
    if (!shouldReplaceFinding(existing.sourceType, data.sourceType)) {
      return;
    }
    Object.assign(existing, {
      status:         data.status,
      findingDetails: data.findingDetails,
      comments:       data.comments,
      sourceType:     data.sourceType,
      scanId:         data.scanId,
    });
    await repo.save(existing);
  } else {
    const f = repo.create(data as any);
    await repo.save(f);
  }
}

async function recordComplianceSnapshot(
  dataSource: DataSource,
  machineId: string,
  scanId: string,
  metrics: {
    score: number; totalControls: number; openFindings: number;
    catIOpen: number; catIIOpen: number; catIIIOpen: number;
    resolved: number; notApplicable: number; notReviewed: number;
  },
): Promise<void> {
  const repo = dataSource.getRepository(ComplianceHistoryEntity);
  const today = new Date().toISOString().slice(0, 10);
  const existing = await repo.findOne({ where: { machineId, snapshotDate: today as any } });
  const entity = existing
    ? Object.assign(existing, { ...metrics, scanId })
    : repo.create({ machineId, snapshotDate: today as any, scanId, ...metrics });
  await repo.save(entity);
}
