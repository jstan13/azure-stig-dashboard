import express from 'express';
import request from 'supertest';

jest.mock('../database/dataSource', () => ({
  AppDataSource: { getRepository: jest.fn(), isInitialized: false },
}));
jest.mock('../gpo/gpoReleaseService', () => {
  const actual = jest.requireActual('../gpo/gpoReleaseService');
  return { ...actual, claimJob: jest.fn() };
});

import { evaluateValidation, claimJob } from '../gpo/gpoReleaseService';
import { gpoAgentRouter } from '../routes/gpo';
import type { ValidationComputer } from '../models/GpoRelease';

const gpoA = { id: '{11111111-1111-1111-1111-111111111111}', name: 'DoD Win11 Comp [Oct 2026 TEST]', sourceBackupId: '{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}', family: 'DoD Windows 11 Computer STIG' };
const gpoB = { id: '{22222222-2222-2222-2222-222222222222}', name: 'DoD Edge Comp [Oct 2026 TEST]', sourceBackupId: '{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}', family: 'DoD Microsoft Edge STIG Computer' };

function computer(overrides: Partial<ValidationComputer> = {}): ValidationComputer {
  return {
    name: 'TESTWS01',
    reachable: true,
    expectedGpoIds: [gpoA.id, gpoB.id],
    appliedGpoIds: ['11111111-1111-1111-1111-111111111111', gpoB.id.toUpperCase()],
    filteredGpoIds: [],
    missingGpoIds: [],
    extensionErrors: [],
    script: null,
    ...overrides,
  };
}

describe('test-environment validation', () => {
  it('passes when every deployed GPO applied cleanly somewhere', () => {
    const outcome = evaluateValidation({ collectedAt: 'now', computers: [computer()] }, [gpoA, gpoB]);
    expect(outcome).toMatchObject({ passed: true, reasons: [] });
  });

  it('never passes without evidence', () => {
    expect(evaluateValidation(undefined, [gpoA]).passed).toBe(false);
    expect(evaluateValidation({ collectedAt: 'now', computers: [] }, [gpoA]).reasons)
      .toContain('No validation computers reported results; configure ValidationComputers on the test agent');
  });

  it('fails on unreachable hosts, missing GPOs, extension errors, and failed scripts', () => {
    const outcome = evaluateValidation({
      collectedAt: 'now',
      computers: [
        computer({ name: 'OFFLINE', reachable: false, error: 'WinRM timeout', appliedGpoIds: [] }),
        computer({ name: 'PARTIAL', appliedGpoIds: [gpoA.id] }),
        computer({ name: 'CSE', extensionErrors: [{ name: 'Registry', code: '0x5' }] }),
        computer({ name: 'SCAN', script: { passed: false, summary: '3 CAT I open' } }),
      ],
    }, [gpoA, gpoB]);
    expect(outcome.passed).toBe(false);
    expect(outcome.reasons).toEqual([
      'OFFLINE: unreachable (WinRM timeout)',
      'PARTIAL: linked GPOs did not apply: DoD Edge Comp [Oct 2026 TEST]',
      'CSE: Group Policy extension errors: Registry (0x5)',
      'SCAN: validation script failed: 3 CAT I open',
    ]);
  });

  it('fails closed when a reachable computer still reports an error', () => {
    const outcome = evaluateValidation({
      collectedAt: 'now',
      computers: [computer({ error: 'Evaluate-STIG crashed', script: null })],
    }, [gpoA, gpoB]);
    expect(outcome).toMatchObject({ passed: false, reasons: ['TESTWS01: Evaluate-STIG crashed'] });
  });

  it('treats WMI-filtered GPOs as expected locally but still requires coverage', () => {
    const outcome = evaluateValidation({
      collectedAt: 'now',
      computers: [computer({ appliedGpoIds: [gpoA.id], filteredGpoIds: [gpoB.id] })],
    }, [gpoA, gpoB]);
    expect(outcome.reasons).toEqual(['DoD Edge Comp [Oct 2026 TEST] did not apply to any validation computer']);
  });
});

describe('GPO agent authorization', () => {
  const claim = claimJob as jest.Mock;

  function app(principal: Record<string, unknown>) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      (req as any).principal = principal;
      next();
    });
    a.use('/api/gpo/agent', gpoAgentRouter);
    return a;
  }

  beforeEach(() => {
    process.env.MOCK_MODE = 'false';
    claim.mockReset().mockResolvedValue(null);
  });

  afterAll(() => {
    process.env.MOCK_MODE = 'true';
  });

  it('rejects delegated user tokens even when they carry the agent role', async () => {
    const res = await request(app({
      objectId: 'user', appRoles: ['gpo-agent-production', 'admin'], groups: [], rawPayload: { scp: 'access_as_user' },
    })).post('/api/gpo/agent/jobs/claim').send({ environment: 'production' });
    expect(res.status).toBe(403);
    expect(claim).not.toHaveBeenCalled();
  });

  it('keeps a test agent out of production jobs', async () => {
    const res = await request(app({
      objectId: 'svc-test', appRoles: ['gpo-agent-test'], groups: [], rawPayload: { idtyp: 'app' },
    })).post('/api/gpo/agent/jobs/claim').send({ environment: 'production' });
    expect(res.status).toBe(403);
    expect(claim).not.toHaveBeenCalled();
  });

  it('lets an application with the matching role poll for work', async () => {
    const res = await request(app({
      objectId: 'svc-test', appRoles: ['gpo-agent-test'], groups: [], rawPayload: { idtyp: 'app', azp: 'gpo-agent' },
    })).post('/api/gpo/agent/jobs/claim').send({ environment: 'test', hostname: 'GPOADM01' });
    expect(res.status).toBe(204);
    expect(claim).toHaveBeenCalledWith(expect.anything(), 'test', expect.objectContaining({ oid: 'svc-test', hostname: 'GPOADM01' }));
  });
});
