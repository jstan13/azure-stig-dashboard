/**
 * SCAP DataStream Importer
 *
 * Parses a SCAP 1.3 Data Stream Collection file (.xml)
 * which bundles XCCDF + OVAL + CPE into a single XML document.
 *
 * Extracts:
 *   - XCCDF Benchmark metadata → StigBenchmarkEntity
 *   - XCCDF Rules (Groups) → ControlEntity (with check type classification)
 *   - OVAL definitions (for check type hints)
 *
 * Called from:
 *   - POST /api/stigs/import-datastream   (multipart file upload)
 *   - stigUpdateScheduler (after downloading new DISA content)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { parseStringPromise } from 'xml2js';
import { DataSource } from 'typeorm';
import { StigBenchmarkEntity } from '../models/StigBenchmark';
import { StigVersionEntity } from '../models/StigVersion';
import { ControlEntity } from '../models/Control';
import { parseCheckContent } from './checkTypeParser';
import { logger } from '../utils/logger';

export interface DataStreamImportResult {
  benchmarkId:    string;
  benchmarkTitle: string;
  version:        string;
  release:        string;
  controlsImported: number;
  controlsUpdated:  number;
}

export async function importScapDataStream(
  filePath: string,
  dataSource: DataSource,
): Promise<DataStreamImportResult> {
  logger.info(`[ScapImporter] Importing SCAP DataStream: ${filePath}`);

  const xml = fs.readFileSync(filePath, 'utf-8');
  const hash = crypto.createHash('sha256').update(xml).digest('hex');

  const doc = await parseStringPromise(xml, { explicitArray: true, ignoreAttrs: false, attrkey: '$', charkey: '_' });

  // Locate XCCDF Benchmark within DataStream
  const benchmark = findBenchmark(doc);
  if (!benchmark) throw new Error('No XCCDF Benchmark found in DataStream');

  const benchmarkId    = benchmark.$?.id ?? 'unknown';
  const benchmarkTitle = textOf(benchmark['dc:title'] ?? benchmark.title ?? benchmark['cdf:title']);
  const version        = textOf(benchmark.version ?? benchmark['cdf:version']);
  const release        = benchmark.$?.['xml:lang'] ?? '';

  // Extract release info from version element attributes
  const versionEl = (benchmark.version ?? benchmark['cdf:version'])?.[0];
  const releaseInfo = typeof versionEl === 'object' ? (versionEl.$?.update ?? '') : '';

  // Persist benchmark + version
  const { benchmark: bm, stigVersion } = await upsertBenchmark(
    dataSource, { benchmarkId, benchmarkTitle, version, releaseInfo, hash, filePath },
  );

  // Extract rules (Groups contain Rule children)
  const groups: any[] = flattenGroups(benchmark['Group'] ?? benchmark['cdf:Group'] ?? []);
  let imported = 0, updated = 0;

  for (const group of groups) {
    const rule = (group['Rule'] ?? group['cdf:Rule'])?.[0];
    if (!rule) continue;

    const result = await upsertControl(dataSource, bm, stigVersion, group, rule);
    if (result === 'created') imported++;
    else if (result === 'updated') updated++;
  }

  logger.info(`[ScapImporter] ${benchmarkTitle} — ${imported} created, ${updated} updated`);
  return { benchmarkId, benchmarkTitle, version, release: releaseInfo, controlsImported: imported, controlsUpdated: updated };
}

// ─── XML navigation ───────────────────────────────────────────────────────────

function findBenchmark(doc: any): any {
  // DataStream: ds:data-stream-collection → ds:component → Benchmark
  const collection = doc['ds:data-stream-collection'] ?? doc['scap:data-stream-collection'];
  if (collection) {
    const components = collection['ds:component'] ?? collection['scap:component'] ?? [];
    for (const comp of components) {
      const bm = comp['cdf:Benchmark'] ?? comp['Benchmark'];
      if (bm) return Array.isArray(bm) ? bm[0] : bm;
    }
  }
  // Plain XCCDF file
  return doc['Benchmark'] ?? doc['cdf:Benchmark'] ?? null;
}

function flattenGroups(groups: any[]): any[] {
  const result: any[] = [];
  for (const g of groups) {
    result.push(g);
    const nested = g['Group'] ?? g['cdf:Group'] ?? [];
    result.push(...flattenGroups(nested));
  }
  return result;
}

function textOf(el: any): string {
  if (!el) return '';
  if (Array.isArray(el)) return textOf(el[0]);
  if (typeof el === 'string') return el;
  if (typeof el === 'object') return el._ ?? el['$']?.text ?? '';
  return String(el);
}

function textArr(el: any): string[] {
  if (!el) return [];
  if (Array.isArray(el)) return el.map(textOf).filter(Boolean);
  return [textOf(el)].filter(Boolean);
}

// ─── DB upsert helpers ────────────────────────────────────────────────────────

async function upsertBenchmark(
  dataSource: DataSource,
  params: { benchmarkId: string; benchmarkTitle: string; version: string; releaseInfo: string; hash: string; filePath: string },
): Promise<{ benchmark: StigBenchmarkEntity; stigVersion: StigVersionEntity }> {
  const bmRepo  = dataSource.getRepository(StigBenchmarkEntity);
  const vRepo   = dataSource.getRepository(StigVersionEntity);

  let bm = await bmRepo.findOne({ where: { benchmarkId: params.benchmarkId } });
  if (!bm) {
    bm = bmRepo.create({ benchmarkId: params.benchmarkId, title: params.benchmarkTitle, publisher: 'DISA', classification: 'UNCLASSIFIED' } as any) as unknown as StigBenchmarkEntity;
    await bmRepo.save(bm);
  }

  let sv = await vRepo.findOne({ where: { benchmarkId: bm!.id, version: params.version } });
  if (!sv) {
    sv = vRepo.create({
      benchmarkId:   bm!.id,
      version:       params.version,
      releaseDate:   new Date(),
      contentHash:   params.hash,
      xccdfPath:     params.filePath,
      isLatest:      true,
    } as any) as unknown as StigVersionEntity;
    // Mark older versions as not latest
    await vRepo.update({ benchmarkId: bm!.id }, { isLatest: false } as any);
    await vRepo.save(sv);
  }

  return { benchmark: bm!, stigVersion: sv! };
}

async function upsertControl(
  dataSource: DataSource,
  bm: StigBenchmarkEntity,
  sv: StigVersionEntity,
  group: any,
  rule: any,
): Promise<'created' | 'updated' | 'skipped'> {
  const repo = dataSource.getRepository(ControlEntity);

  const vulnId  = textOf(group['$']?.id ?? '').replace(/^xccdf_.*_group_/, '');
  const ruleId  = textOf(rule['$']?.id ?? '');
  const title   = textOf(rule['title'] ?? rule['cdf:title']);
  const severity = mapSeverity(rule['$']?.severity ?? group['$']?.severity);
  const descRaw  = textOf(rule['description'] ?? rule['cdf:description']);

  // Extract CCIs
  const referenceEls: any[] = rule['reference'] ?? rule['cdf:reference'] ?? [];
  const ccis = referenceEls
    .filter((r: any) => textOf(r).startsWith('CCI-'))
    .map((r: any) => textOf(r));

  // Extract check content for classification
  const checkEl    = (rule['check'] ?? rule['cdf:check'])?.[0];
  const checkContent = textOf(checkEl?.['check-content'] ?? checkEl?.['cdf:check-content']);

  const classified = parseCheckContent(checkContent + '\n' + descRaw, title, '');

  const controlId = `${bm.benchmarkId}|${vulnId}`;

  const existing = await repo.findOne({ where: { id: controlId } });
  if (existing) {
    Object.assign(existing, {
      title, severity, checkType: classified.checkType,
      checkParameters: classified.checkParameters,
      ccis, stigVersionId: sv.id,
    });
    await repo.save(existing);
    return 'updated';
  } else {
    const ctrl = repo.create({
      id:               controlId,
      vulnId,
      ruleId,
      stigId:           bm.benchmarkId,
      groupId:          textOf(group['$']?.id ?? ''),
      title,
      severity,
      checkType:        classified.checkType,
      checkParameters:  classified.checkParameters,
      ccis,
      stigVersionId:    sv.id,
      azurePolicyIds:   [],
      defenderRuleIds:  [],
    } as any);
    await repo.save(ctrl);
    return 'created';
  }
}

function mapSeverity(s: string | undefined): string {
  switch (s?.toLowerCase()) {
    case 'high':   case 'i':   return 'high';
    case 'medium': case 'ii':  return 'medium';
    case 'low':    case 'iii': return 'low';
    default:                   return 'medium';
  }
}
