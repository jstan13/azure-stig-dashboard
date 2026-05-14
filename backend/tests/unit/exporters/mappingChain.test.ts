/**
 * Unit tests for the export orchestrator's mappingChain enforcement
 * (constitution Principle IV / FR-009, T108 / T115).
 */
import {
  enforceMappingChain,
  MappingChainViolationError,
  type FindingForExport,
  type MappingChain,
} from '../../../src/exporters';

const completeChain = (over: Partial<MappingChain> = {}): MappingChain => ({
  source: 'azure-policy',
  sourceRef: 'policy-assignment-1',
  vulnNum: 'V-220706',
  ruleId: 'SV-220706r569186_rule',
  cciRefs: ['CCI-000196'],
  nistControls: ['IA-5 (1) (c)'],
  stigBenchmarkId: 'Microsoft_Windows_Server_2022_STIG',
  stigBenchmarkVersion: 'V1R3',
  benchmarkSha256: 'abc123',
  mappedAt: '2026-05-07T12:00:00.000Z',
  mappedBy: 'mc-windows-2022@1.4.0',
  ...over,
});

const finding = (
  id: string,
  mappingChain: Partial<MappingChain> | null,
): FindingForExport => ({
  id,
  machineId: 'm1',
  controlId: 'V-220706',
  status: 'Open',
  severity: 'CAT_II',
  mappingChain,
});

describe('enforceMappingChain', () => {
  it('returns findings unchanged when every entry has a complete mappingChain', () => {
    const findings = [finding('f1', completeChain()), finding('f2', completeChain())];
    expect(enforceMappingChain(findings)).toBe(findings);
  });

  it('throws with reason="missing" when mappingChain is null', () => {
    try {
      enforceMappingChain([finding('f1', null), finding('f2', completeChain())]);
      fail('expected MappingChainViolationError');
    } catch (err) {
      expect(err).toBeInstanceOf(MappingChainViolationError);
      const e = err as MappingChainViolationError;
      expect(e.statusCode).toBe(422);
      expect(e.errorCode).toBe('MAPPING_CHAIN_INCOMPLETE');
      expect(e.violations).toHaveLength(1);
      expect(e.violations[0]).toMatchObject({ findingId: 'f1', reason: 'missing' });
      expect(e.violations[0].missingFields).toContain('source');
      expect(e.violations[0].missingFields).toContain('benchmarkSha256');
    }
  });

  it('throws with reason="incomplete" when individual fields are blank', () => {
    const partial = completeChain({ benchmarkSha256: '', cciRefs: [] });
    try {
      enforceMappingChain([finding('f1', partial)]);
      fail('expected MappingChainViolationError');
    } catch (err) {
      const e = err as MappingChainViolationError;
      expect(e.violations).toHaveLength(1);
      expect(e.violations[0].reason).toBe('incomplete');
      expect(e.violations[0].missingFields.sort()).toEqual(
        ['benchmarkSha256', 'cciRefs'].sort(),
      );
    }
  });

  it('aggregates violations across multiple findings', () => {
    try {
      enforceMappingChain([
        finding('f1', null),
        finding('f2', completeChain({ ruleId: '' })),
        finding('f3', completeChain()),
      ]);
      fail('expected MappingChainViolationError');
    } catch (err) {
      const e = err as MappingChainViolationError;
      expect(e.violations).toHaveLength(2);
      expect(e.violations.map((v) => v.findingId).sort()).toEqual(['f1', 'f2']);
    }
  });
});
