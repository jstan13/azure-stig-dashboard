/**
 * Tests for POA&M API routes (integration-style with supertest)
 *
 * Runs in MOCK_MODE=true — no real DB or Azure AD needed.
 */

process.env.MOCK_MODE = 'true';
process.env.JWT_SECRET = 'test-secret';

import request from 'supertest';
import app from '../index';
import { mockStore } from '../database/dataSource';
import { seedMock } from '../database/mockSeed';

// A finding-linked POA&M derives its severity/scheduledCompletion from that
// finding rather than from the request body. Resolve one finding id per
// severity up front so each test can link to a realistic one.
const findingIdBySeverity: Record<string, string> = {};

beforeAll(async () => {
  await request(app).get('/health').expect(200);
  seedMock(mockStore);
  for (const f of mockStore.findings) {
    if (!findingIdBySeverity[f.severity]) findingIdBySeverity[f.severity] = f.id;
  }
});

describe('POST /api/poams', () => {
  it('returns 400 when weakness is missing', async () => {
    const res = await request(app).post('/api/poams').send({ findingId: findingIdBySeverity.high });
    expect(res.status).toBe(400);
  });

  it('returns 400 when neither findingId nor severity is provided', async () => {
    const res = await request(app).post('/api/poams').send({ weakness: 'Orphan weakness' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/severity/i);
  });

  it('creates a standalone POA&M for a weakness found outside scanning', async () => {
    const res = await request(app).post('/api/poams').send({
      weakness: 'Annual assessment: no documented incident response test',
      severity: 'medium',
      controlAcronym: ' ir-3 (2) ',
      sourceIdentifyingControl: 'FY25 security control assessment',
      countermeasures: 'Schedule tabletop exercise',
      description: '',
    });
    expect(res.status).toBe(201);
    expect(res.body.poamId).toMatch(/^POA-\d{4}-\d{4}$/);
    expect(res.body.findingId).toBeNull();
    expect(res.body.severity).toBe('medium');
    expect(res.body.controlAcronym).toBe('IR-3(2)');
    expect(res.body.sourceIdentifyingControl).toBe('FY25 security control assessment');
    expect(res.body.description).toBeUndefined();
    const days = Math.round((new Date(res.body.scheduledCompletion).getTime() - Date.now()) / 86_400_000);
    expect(days).toBeGreaterThanOrEqual(88);
    expect(days).toBeLessThanOrEqual(92);

    const list = await request(app).get('/api/poams');
    expect(list.body.data.some((p: any) => p.id === res.body.id)).toBe(true);
  });

  it('honours an explicit scheduledCompletion', async () => {
    const res = await request(app).post('/api/poams').send({
      weakness: 'Pen test finding', severity: 'high', scheduledCompletion: '2030-01-15',
    });
    expect(res.status).toBe(201);
    expect(res.body.scheduledCompletion.startsWith('2030-01-15')).toBe(true);
  });

  it.each<[Record<string, string>, string]>([
    [{ severity: 'critical' }, 'unknown severity'],
    [{ severity: 'low', controlAcronym: 'not a control' }, 'malformed control'],
    [{ severity: 'low', scheduledCompletion: 'someday' }, 'unparseable date'],
  ])('returns 400 for %j (%s)', async (extra, _why) => {
    const res = await request(app).post('/api/poams').send({ weakness: 'Bad input', ...extra });
    expect(res.status).toBe(400);
  });

  it('takes severity from the linked finding over the request body', async () => {
    const res = await request(app).post('/api/poams').send({
      findingId: findingIdBySeverity.high, weakness: 'Linked', severity: 'low',
    });
    expect(res.status).toBe(201);
    expect(res.body.severity).toBe('high');
    expect(res.body.findingId).toBe(findingIdBySeverity.high);
  });

  it('returns 404 when findingId does not exist', async () => {
    const res = await request(app)
      .post('/api/poams')
      .send({ findingId: 'nonexistent-finding-xyz', weakness: 'Test weakness' });
    expect(res.status).toBe(404);
  });

  it('creates a new POA&M with required fields', async () => {
    const res = await request(app)
      .post('/api/poams')
      .send({
        findingId: findingIdBySeverity.high,
        weakness: 'Test weakness',
        impact:   'Loss of data confidentiality',
      });
    expect(res.status).toBe(201);
    expect(res.body.poamId).toMatch(/^POA-/);
    expect(res.body.weakness).toBe('Test weakness');
    expect(res.body.status).toBe('open');
  });

  it('assigns a sequential poamId', async () => {
    const r1 = await request(app).post('/api/poams').send({ findingId: findingIdBySeverity.medium, weakness: 'W1' });
    const r2 = await request(app).post('/api/poams').send({ findingId: findingIdBySeverity.low, weakness: 'W2' });
    const id1 = parseInt(r1.body.poamId.split('-').pop());
    const id2 = parseInt(r2.body.poamId.split('-').pop());
    expect(id2).toBeGreaterThan(id1);
  });

  it('auto-sets scheduledCompletion based on the finding severity', async () => {
    const res = await request(app)
      .post('/api/poams')
      .send({ findingId: findingIdBySeverity.high, weakness: 'CAT I finding' });
    expect(res.status).toBe(201);
    expect(res.body.scheduledCompletion).toBeDefined();
    const due = new Date(res.body.scheduledCompletion);
    const diff = Math.round((due.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    // CAT I = 30 days (±2 for test timing)
    expect(diff).toBeGreaterThanOrEqual(28);
    expect(diff).toBeLessThanOrEqual(32);
  });
});

describe('GET /api/poams', () => {
  it('returns a paginated envelope with a data array and total', async () => {
    const res = await request(app).get('/api/poams');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(typeof res.body.total).toBe('number');
  });

  it('filters by status', async () => {
    // Create one with known status
    await request(app).post('/api/poams').send({ findingId: findingIdBySeverity.medium, weakness: 'Filter test' });
    const res = await request(app).get('/api/poams?status=open');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    res.body.data.forEach((p: any) => expect(p.status).toBe('open'));
  });
});

describe('GET /api/poams/:id', () => {
  let createdId: string;

  beforeAll(async () => {
    const res = await request(app).post('/api/poams').send({ findingId: findingIdBySeverity.low, weakness: 'Detail test' });
    createdId = res.body.id;
  });

  it('returns the POA&M by id', async () => {
    const res = await request(app).get(`/api/poams/${createdId}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(createdId);
  });

  it('returns 404 for unknown id', async () => {
    const res = await request(app).get('/api/poams/nonexistent-id-xyz');
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/poams/:id', () => {
  let poamId: string;

  beforeAll(async () => {
    const res = await request(app).post('/api/poams').send({ findingId: findingIdBySeverity.high, weakness: 'Patch test' });
    poamId = res.body.id;
  });

  it('updates status to in_remediation', async () => {
    const res = await request(app).patch(`/api/poams/${poamId}`).send({ status: 'in_remediation' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('in_remediation');
  });

  it('updates assignedToName', async () => {
    const res = await request(app).patch(`/api/poams/${poamId}`).send({ assignedToName: 'Alice Admin' });
    expect(res.status).toBe(200);
    expect(res.body.assignedToName).toBe('Alice Admin');
  });

  it('returns 404 for unknown id', async () => {
    const res = await request(app).patch('/api/poams/no-such-id').send({ status: 'closed' });
    expect(res.status).toBe(404);
  });

  it('refuses risk acceptance outside the approval workflow', async () => {
    const res = await request(app).patch(`/api/poams/${poamId}`).send({ status: 'risk_accepted' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/approve/);
  });

  it('refuses to change the severity of a finding-linked POA&M', async () => {
    const res = await request(app).patch(`/api/poams/${poamId}`).send({ severity: 'low' });
    expect(res.status).toBe(400);
  });

  it('stamps actualCompletion on resolve and clears it on reopen', async () => {
    const resolved = await request(app).patch(`/api/poams/${poamId}`).send({ status: 'resolved' });
    expect(resolved.body.actualCompletion).toBeTruthy();
    const reopened = await request(app).patch(`/api/poams/${poamId}`).send({ status: 'open' });
    expect(reopened.body.actualCompletion).toBeNull();
  });
});

describe('PATCH /api/poams/:id (manual POA&M)', () => {
  let poamId: string;

  beforeAll(async () => {
    const res = await request(app).post('/api/poams').send({
      weakness: 'Editable', severity: 'low', controlAcronym: 'AC-2', sourceIdentifyingControl: 'Audit',
    });
    poamId = res.body.id;
  });

  it('edits severity, control, source and due date', async () => {
    const res = await request(app).patch(`/api/poams/${poamId}`).send({
      severity: 'high', controlAcronym: 'sc-7 (5)', sourceIdentifyingControl: 'Pen test', scheduledCompletion: '2031-03-01',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ severity: 'high', controlAcronym: 'SC-7(5)', sourceIdentifyingControl: 'Pen test' });
    expect(res.body.scheduledCompletion.startsWith('2031-03-01')).toBe(true);
  });

  it('clears optional fields with an empty string and leaves omitted fields alone', async () => {
    const res = await request(app).patch(`/api/poams/${poamId}`).send({ controlAcronym: '' });
    expect(res.status).toBe(200);
    expect(res.body.controlAcronym).toBeNull();
    expect(res.body.sourceIdentifyingControl).toBe('Pen test');
  });

  it.each<[Record<string, unknown>]>([
    [{ controlAcronym: 'nope' }],
    [{ weakness: '   ' }],
    [{ scheduledCompletion: 'soon' }],
    [{ severity: 'critical' }],
  ])('rejects %j', async (body) => {
    const res = await request(app).patch(`/api/poams/${poamId}`).send(body);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/poams/bulk-create', () => {
  it('rejects an unknown severity', async () => {
    const res = await request(app).post('/api/poams/bulk-create').send({ severity: 'critical' });
    expect(res.status).toBe(400);
  });

  it('creates one POA&M per open finding without an existing POA&M', async () => {
    const first = await request(app).post('/api/poams/bulk-create').send({ severity: 'medium' });
    expect(first.status).toBe(201);
    expect(first.body.created).toBeGreaterThan(0);
    expect(first.body.poams.every((p: any) => p.severity === 'medium' && p.findingId)).toBe(true);
    const again = await request(app).post('/api/poams/bulk-create').send({ severity: 'medium' });
    expect(again.body.created).toBe(0);
  });
});

describe('POST /api/poams/:id/milestones', () => {
  let poamId: string;

  beforeAll(async () => {
    const res = await request(app).post('/api/poams').send({ findingId: findingIdBySeverity.medium, weakness: 'Milestone host' });
    poamId = res.body.id;
  });

  it('adds a milestone', async () => {
    const res = await request(app)
      .post(`/api/poams/${poamId}/milestones`)
      .send({ description: 'Apply registry patch', dueDate: '2025-06-30' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.description).toBe('Apply registry patch');
  });

  it('requires description', async () => {
    const res = await request(app).post(`/api/poams/${poamId}/milestones`).send({});
    expect(res.status).toBe(400);
  });
});

describe('GET /api/poams/export', () => {
  it('returns CSV with proper content-type', async () => {
    const res = await request(app).get('/api/poams/export');
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/text\/csv/);
  });

  it('rejects an unknown status filter', async () => {
    const res = await request(app).get('/api/poams/export?status=bogus');
    expect(res.status).toBe(400);
  });
});

describe('Milestone updates', () => {
  let poamId: string;
  let milestoneId: string;

  beforeAll(async () => {
    const res = await request(app).post('/api/poams').send({ weakness: 'Milestone edits', severity: 'low' });
    poamId = res.body.id;
    const ms = await request(app).post(`/api/poams/${res.body.poamId}/milestones`).send({ description: 'Step 1' });
    milestoneId = ms.body.id;
  });

  it('only applies known fields, so a milestone cannot be moved or re-keyed', async () => {
    const res = await request(app)
      .patch(`/api/poams/${poamId}/milestones/${milestoneId}`)
      .send({ status: 'completed', id: 'hijacked', poamId: 'other-poam', createdAt: '1999-01-01' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: milestoneId, poamId, status: 'completed' });
    expect(res.body.completedAt).toBeTruthy();
    expect(res.body.createdAt).not.toBe('1999-01-01');
  });

  it('rejects an unknown milestone status', async () => {
    const res = await request(app).patch(`/api/poams/${poamId}/milestones/${milestoneId}`).send({ status: 'done' });
    expect(res.status).toBe(400);
  });

  it('returns 404 when deleting a milestone that does not exist', async () => {
    const res = await request(app).delete(`/api/poams/${poamId}/milestones/not-a-milestone`);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/poams/:id/approve (risk acceptance)', () => {
  let poam: any;
  let finding: any;

  const handOffToAnotherAuthor = (id: string) => {
    const stored = (mockStore.poams ?? []).find((p: any) => p.id === id);
    stored.createdByOid = 'another-isso-oid';
  };

  beforeAll(async () => {
    finding = mockStore.findings.find((f: any) =>
      f.status === 'open' && !(mockStore.poams ?? []).some((p: any) => p.findingId === f.id));
    const res = await request(app).post('/api/poams').send({ findingId: finding.id, weakness: 'Accept me' });
    poam = res.body;
  });

  it('refuses the POA&M creator (separation of duties)', async () => {
    const res = await request(app).post(`/api/poams/${poam.id}/approve`).send({ rationale: 'Mine' });
    expect(res.status).toBe(403);
  });

  it('requires a rationale', async () => {
    handOffToAnotherAuthor(poam.id);
    const res = await request(app).post(`/api/poams/${poam.id}/approve`).send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/rationale/);
  });

  it('rejects a residual risk outside the eMASS scale', async () => {
    const res = await request(app).post(`/api/poams/${poam.id}/approve`).send({ rationale: 'x', residualRisk: 'meh' });
    expect(res.status).toBe(400);
  });

  it('accepts the risk using the drafted rationale and records the approver', async () => {
    const draft = await request(app).patch(`/api/poams/${poam.id}`).send({ riskAcceptanceRationale: 'Compensated by NSG deny-all' });
    expect(draft.status).toBe(200);

    const res = await request(app).post(`/api/poams/${poam.poamId}/approve`).send({ residualRisk: 'moderate' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'risk_accepted',
      riskAcceptanceRationale: 'Compensated by NSG deny-all',
      residualRisk: 'Moderate',
    });
    expect(res.body.approvedAt).toBeTruthy();
    expect(res.body.approvedByOid).toBeTruthy();
    expect(res.body.approvedByName).toBeTruthy();
  });

  it('refuses a second approval', async () => {
    const res = await request(app).post(`/api/poams/${poam.id}/approve`).send({ rationale: 'Again' });
    expect(res.status).toBe(409);
  });

  it('locks the rationale and residual risk once accepted', async () => {
    const r1 = await request(app).patch(`/api/poams/${poam.id}`).send({ riskAcceptanceRationale: 'Changed' });
    const r2 = await request(app).patch(`/api/poams/${poam.id}`).send({ residualRisk: 'Low' });
    expect(r1.status).toBe(409);
    expect(r2.status).toBe(409);
  });

  it('freezes what the approver signed off on, but not tracking fields', async () => {
    for (const change of [{ weakness: 'Different' }, { impact: 'Worse' }, { countermeasures: 'None' }, { controlAcronym: 'SC-7' }]) {
      const res = await request(app).patch(`/api/poams/${poam.id}`).send(change);
      expect(res.status).toBe(409);
    }
    const ok = await request(app).patch(`/api/poams/${poam.id}`).send({ assignedToName: 'Pat Owner' });
    expect(ok.status).toBe(200);
    expect(ok.body.approvedAt).toBeTruthy();
  });

  it('exports the acceptance in the POA&M CSV', async () => {
    const res = await request(app).get('/api/poams/export');
    expect(res.status).toBe(200);
    const [header, ...rows] = res.text.split('\r\n');
    expect(header).toContain('Risk Accepted By');
    const row = rows.find((r) => r.startsWith(poam.poamId));
    expect(row).toContain('Compensated by NSG deny-all');
    expect(row).toContain('Moderate');
    expect(row).toContain('risk_accepted');
  });

  it('writes the acceptance into the linked finding\'s CKL comments and keeps it Open', async () => {
    const res = await request(app)
      .post('/api/export/checklist')
      .send({ machineId: finding.machineId, format: 'json' });
    expect(res.status).toBe(200);
    const exported = res.body.findings.find((f: any) => f.comments?.includes(poam.poamId));
    expect(exported).toBeDefined();
    expect(exported.status).toBe('open');
    expect(exported.comments).toMatch(/Risk accepted under POA-\d{4}-\d{4} by .+ on \d{4}-\d{2}-\d{2}\. Residual risk: Moderate\. Rationale: Compensated by NSG deny-all/);

    const ckl = await request(app).post('/api/export/checklist').send({ machineId: finding.machineId, format: 'ckl' });
    expect(ckl.text).toContain(`Risk accepted under ${poam.poamId}`);
  });

  it('withdraws the acceptance when the status changes, unlocking the rationale', async () => {
    const res = await request(app).patch(`/api/poams/${poam.id}`).send({ status: 'in_remediation' });
    expect(res.status).toBe(200);
    expect(res.body.approvedAt).toBeNull();
    expect(res.body.approvedByOid).toBeNull();

    const edit = await request(app).patch(`/api/poams/${poam.id}`).send({ riskAcceptanceRationale: 'Revised' });
    expect(edit.status).toBe(200);

    const json = await request(app).post('/api/export/checklist').send({ machineId: finding.machineId, format: 'json' });
    expect(json.body.findings.some((f: any) => f.comments?.includes(poam.poamId))).toBe(false);
  });

  it('only accepts risk on open or in-remediation POA&Ms', async () => {
    const created = await request(app).post('/api/poams').send({ weakness: 'Already fixed', severity: 'low' });
    handOffToAnotherAuthor(created.body.id);
    await request(app).patch(`/api/poams/${created.body.id}`).send({ status: 'closed' });
    const res = await request(app).post(`/api/poams/${created.body.id}/approve`).send({ rationale: 'Too late' });
    expect(res.status).toBe(409);
  });

  it('does not freeze a legacy row that kept approvedAt after leaving risk_accepted', async () => {
    const created = await request(app).post('/api/poams').send({ weakness: 'Legacy', severity: 'low' });
    const row = mockStore.poams.find((p: any) => p.id === created.body.id);
    row.approvedAt = '2025-01-01T00:00:00.000Z';
    const res = await request(app).patch(`/api/poams/${created.body.id}`).send({ weakness: 'Legacy, edited' });
    expect(res.status).toBe(200);
  });
});
