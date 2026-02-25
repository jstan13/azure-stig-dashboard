/**
 * XCCDF Parser
 *
 * Parses a DISA STIG XCCDF XML document into structured data that can be
 * upserted into the StigBenchmark, StigVersion, and Control tables.
 *
 * Supports XCCDF 1.1 and 1.2 schemas as published by DISA.
 *
 * Key parsed elements:
 *   <Benchmark>        → StigBenchmark + StigVersion
 *   <Group>/<Rule>     → ControlEntity (one per Vuln_Num)
 *   <check-content>    → checkContent text + parsed checkParameters (via CheckTypeParser)
 *   <ident>            → CCI list
 */

import { XMLParser } from 'fast-xml-parser';
import { logger } from '../utils/logger';
import { parseCheckContent } from './checkTypeParser';

export interface ParsedBenchmark {
  benchmarkId: string;
  title: string;
  version: string;         // "V2R8"
  releaseInfo: string;
  benchmarkDate: string;
  description: string;
  controls: ParsedControl[];
}

export interface ParsedControl {
  id: string;              // composite key: "<benchmarkId>|<vulnId>"
  vulnId: string;          // V-220700
  ruleId: string;          // SV-220700r849121_rule
  stigId: string;          // WN10-AU-000005 (Rule_Ver)
  groupId: string;         // SRG reference
  title: string;
  severity: 'high' | 'medium' | 'low' | 'informational';
  description: string;
  checkContent: string;
  fixText: string;
  checkType: string;
  checkParameters: Record<string, any>;
  ccis: string[];
  stigName: string;
  rawXml?: string;
}

const SEVERITY_MAP: Record<string, 'high' | 'medium' | 'low' | 'informational'> = {
  high: 'high',
  medium: 'medium',
  low: 'low',
  info: 'informational',
  informational: 'informational',
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  trimValues: true,
  isArray: (tagName) => ['Group', 'Rule', 'ident', 'reference', 'fix'].includes(tagName),
});

/**
 * Parse a DISA XCCDF XML string into a ParsedBenchmark.
 */
export function parseXccdf(xml: string): ParsedBenchmark {
  logger.info('[XCCDFParser] Parsing XCCDF document');

  const doc = parser.parse(xml);
  const benchmark = doc['Benchmark'] || doc['xccdf:Benchmark'] || doc['cdf:Benchmark'];
  if (!benchmark) throw new Error('No <Benchmark> root element found in XCCDF');

  const benchmarkId = benchmark['@_id'] || '';
  const title = getText(benchmark['title']);
  const version = getText(benchmark['version']);
  const description = getText(benchmark['description']);

  // Release info is in <plain-text id="release-info"> or <status>
  const releaseInfo = getPlainText(benchmark, 'release-info') ||
    getText(benchmark['status']);
  const benchmarkDate = benchmark['status']?.['@_date'] || '';

  // Parse version string into V<n>R<n> format
  const releaseMatch = releaseInfo.match(/Release:\s*(\d+)/i);
  const versionMatch = getText(benchmark['version']).match(/(\d+)/);
  const release = releaseMatch?.[1] || '0';
  const ver = versionMatch?.[1] || '0';
  const versionString = `V${ver}R${release}`;

  const groups: any[] = ensureArray(benchmark['Group']);
  logger.info(`[XCCDFParser] Found ${groups.length} groups in ${benchmarkId}`);

  const controls: ParsedControl[] = [];

  for (const group of groups) {
    const vulnId = group['@_id'] || '';
    const groupTitle = getText(group['title']);

    const rules = ensureArray(group['Rule']);
    for (const rule of rules) {
      try {
        const control = parseRule(rule, vulnId, groupTitle, benchmarkId, title);
        if (control) controls.push(control);
      } catch (err: any) {
        logger.warn(`[XCCDFParser] Failed to parse rule in group ${vulnId}: ${err.message}`);
      }
    }
  }

  logger.info(`[XCCDFParser] Parsed ${controls.length} controls from ${benchmarkId} ${versionString}`);

  return {
    benchmarkId,
    title,
    version: versionString,
    releaseInfo,
    benchmarkDate,
    description,
    controls,
  };
}

function parseRule(
  rule: any,
  vulnId: string,
  groupId: string,
  benchmarkId: string,
  stigName: string,
): ParsedControl | null {
  const ruleId = rule['@_id'] || '';
  const severityRaw = rule['@_severity'] || 'medium';
  const severity = SEVERITY_MAP[severityRaw.toLowerCase()] || 'medium';

  const title = getText(rule['title']);
  const description = stripHtml(getText(rule['description']));
  const version = getText(rule['version']); // Rule_Ver / STIG ID e.g. WN10-AU-000005

  // Check content
  const checkNode = rule['check'];
  const checkContentNode = checkNode?.['check-content'] || checkNode?.['check-content-ref'];
  const checkContent = typeof checkContentNode === 'string'
    ? checkContentNode
    : getText(checkContentNode);

  // Fix text
  const fixNodes = ensureArray(rule['fix'] || rule['fixtext']);
  const fixText = fixNodes.map((f: any) => (typeof f === 'string' ? f : getText(f))).join('\n\n');

  // CCIs
  const identNodes = ensureArray(rule['ident']);
  const ccis = identNodes
    .map((i: any) => (typeof i === 'string' ? i : i['#text'] || ''))
    .filter((s: string) => s.startsWith('CCI-'));

  // Parse check content into structured parameters
  const { checkType, checkParameters } = parseCheckContent(checkContent, title, version);

  return {
    id: `${benchmarkId}|${vulnId}`,
    vulnId,
    ruleId,
    stigId: version,      // "WN10-AU-000005" — the STIG check ID
    groupId,
    title,
    severity,
    description,
    checkContent,
    fixText,
    checkType,
    checkParameters,
    ccis,
    stigName,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getText(node: any): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'object') {
    return node['#text'] || node['p'] || node['div'] || Object.values(node).find((v) => typeof v === 'string') || '';
  }
  return String(node);
}

function getPlainText(benchmark: any, id: string): string {
  const nodes = ensureArray(benchmark['plain-text']);
  const node = nodes.find((n: any) => n['@_id'] === id);
  return node ? getText(node) : '';
}

function ensureArray(val: any): any[] {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return [val];
}

/** Strip basic HTML tags from XCCDF description text */
function stripHtml(text: string): string {
  return text.replace(/<[^>]*>/g, ' ').replace(/\s{2,}/g, ' ').trim();
}
