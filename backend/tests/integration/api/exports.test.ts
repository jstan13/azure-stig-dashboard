/**
 * Contract test for POST /api/export/checklist mappingChain enforcement
 * (constitution Principle IV / FR-009, T108).
 *
 * Verifies that when STRICT_TRACEABILITY=true, exports are rejected with 422
 * if any finding lacks a complete mappingChain. When STRICT_TRACEABILITY is
 * unset/false (legacy mode), exports succeed even when mappingChain is
 * absent so existing fixture-based tests keep passing.
 */
import request from 'supertest';

// Force MOCK_MODE before importing the app so middleware injects a mock admin
process.env.MOCK_MODE = 'true';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { mockStore } = require('../../src/database/dataSource');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require('../../src/index').default;

const completeChain = () => ({
  source: 'azure-policy',
  sourceRef: 'pa-001',
  vulnNum: 'V-220706',
  ruleId: 'SV-220706r569186_rule',
  cciRefs: ['CCI-000196'],
  nistControls: ['IA-5'],
  stigBenchmarkId: 'Microsoft_Windows_Server_2022_STIG',
  stigBenchmarkVersion: 'V1R3',
  benchmarkSha256: 'abc123',
  mappedAt: '2026-05-07T12:00:00.000Z',
  mappedBy: 'mc@1.0.0',
});

describe('POST /api/export/checklist mappingChain enforcement', () => {
  const originalStrict = process.env.STRICT_TRACEABILITY;
  const machineId: string = mockStore.machines[0]?.id;

  afterEach(() => {
    process.env.STRICT_TRACEABILITY = originalStrict;
    // Restore findings to their original mappingChain state
    for (const f of mockStore.findings) {
      delete (f as any).mappingChain;
    }
  });

  it('returns 200 when STRICT_TRACEABILITY is unset (legacy fixtures)', async () => {
    delete process.env.STRICT_TRACEABILITY;
    const res = await request(app)
      .post('/api/export/checklist')
      .send({ machineId, format: 'json' });
    expect(res.status).toBe(200);
  });

  it('returns 422 with violations when STRICT_TRACEABILITY=true and findings lack mappingChain', async () => {
    process.env.STRICT_TRACEABILITY = 'true';
    const res = await request(app)
      .post('/api/export/checklist')
      .send({ machineId, format: 'ckl' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('MAPPING_CHAIN_INCOMPLETE');
    expect(Array.isArray(res.body.violations)).toBe(true);
    expect(res.body.violations.length).toBeGreaterThan(0);
    expect(res.body.violations[0]).toHaveProperty('findingId');
    expect(res.body.violations[0]).toHaveProperty('reason');
    expect(res.body.violations[0]).toHaveProperty('missingFields');
  });

  it('returns 200 when STRICT_TRACEABILITY=true and every finding has a complete mappingChain', async () => {
    process.env.STRICT_TRACEABILITY = 'true';
    for (const f of mockStore.findings) {
      if (f.machineId === machineId) {
        (f as any).mappingChain = completeChain();
      }
    }
    const res = await request(app)
      .post('/api/export/checklist')
      .send({ machineId, format: 'json' });
    expect(res.status).toBe(200);
    expect(res.body.findings).toBeDefined();
  });
});
