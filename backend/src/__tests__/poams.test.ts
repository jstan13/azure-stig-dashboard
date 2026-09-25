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
});
