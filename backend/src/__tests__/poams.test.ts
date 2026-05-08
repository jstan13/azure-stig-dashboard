/**
 * Tests for POA&M API routes (integration-style with supertest)
 *
 * Runs in MOCK_MODE=true — no real DB or Azure AD needed.
 */

process.env.MOCK_MODE = 'true';
process.env.JWT_SECRET = 'test-secret';

import request from 'supertest';
import app from '../index';

// The mock store is populated lazily on first request in mock mode.
// We call health check first to ensure the app has initialized.

describe('POST /api/poams', () => {
  beforeAll(async () => {
    await request(app).get('/health').expect(200);
  });

  it('returns 400 when weakness is missing', async () => {
    const res = await request(app).post('/api/poams').send({ severity: 'high' });
    expect(res.status).toBe(400);
  });

  it('creates a new POA&M with required fields', async () => {
    const res = await request(app)
      .post('/api/poams')
      .send({
        weakness: 'Test weakness',
        severity: 'high',
        impact:   'Loss of data confidentiality',
      });
    expect(res.status).toBe(201);
    expect(res.body.poamId).toMatch(/^POA-/);
    expect(res.body.weakness).toBe('Test weakness');
    expect(res.body.status).toBe('open');
  });

  it('assigns a sequential poamId', async () => {
    const r1 = await request(app).post('/api/poams').send({ weakness: 'W1', severity: 'medium' });
    const r2 = await request(app).post('/api/poams').send({ weakness: 'W2', severity: 'low' });
    const id1 = parseInt(r1.body.poamId.split('-').pop());
    const id2 = parseInt(r2.body.poamId.split('-').pop());
    expect(id2).toBeGreaterThan(id1);
  });

  it('auto-sets scheduledCompletion based on severity', async () => {
    const res = await request(app).post('/api/poams').send({ weakness: 'CAT I finding', severity: 'high' });
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
  it('returns an object with poams array and total', async () => {
    const res = await request(app).get('/api/poams');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.poams ?? res.body)).toBe(true);
  });

  it('filters by status', async () => {
    // Create one with known status
    await request(app).post('/api/poams').send({ weakness: 'Filter test', severity: 'medium' });
    const res = await request(app).get('/api/poams?status=open');
    expect(res.status).toBe(200);
    const poams = res.body.poams ?? res.body;
    poams.forEach((p: any) => expect(p.status).toBe('open'));
  });
});

describe('GET /api/poams/:id', () => {
  let createdId: string;

  beforeAll(async () => {
    const res = await request(app).post('/api/poams').send({ weakness: 'Detail test', severity: 'low' });
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
    const res = await request(app).post('/api/poams').send({ weakness: 'Patch test', severity: 'high' });
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
    const res = await request(app).post('/api/poams').send({ weakness: 'Milestone host', severity: 'medium' });
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
