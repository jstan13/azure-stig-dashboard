import request from 'supertest';
import app from '../index';
import { mockStore } from '../database/dataSource';
import { seedMock } from '../database/mockSeed';

// Re-seed before each test suite
beforeAll(() => {
  seedMock(mockStore);
});

describe('GET /health', () => {
  it('should return 200 with status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('GET /api/machines', () => {
  it('should return machine list (mock auth injected)', async () => {
    const res = await request(app).get('/api/machines');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.total).toBeGreaterThan(0);
  });

  it('should support search query', async () => {
    const res = await request(app).get('/api/machines?q=WIN10');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('should return paginated results', async () => {
    const res = await request(app).get('/api/machines?page=1&pageSize=1');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(1);
  });
});

describe('GET /api/machines/:id', () => {
  it('should return machine details with findings', async () => {
    const machineId = mockStore.machines[0]?.id;
    const res = await request(app).get(`/api/machines/${machineId}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(machineId);
    expect(Array.isArray(res.body.findings)).toBe(true);
    expect(res.body.summary).toBeDefined();
  });

  it('should return 404 for unknown machine', async () => {
    const res = await request(app).get('/api/machines/nonexistent-id');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/controls', () => {
  it('should return control list', async () => {
    const res = await request(app).get('/api/controls');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.total).toBeGreaterThan(0);
  });
});

describe('GET /api/groups/:id/compliance', () => {
  it('should return group compliance rollup', async () => {
    const res = await request(app).get('/api/groups/rg-demo/compliance');
    expect(res.status).toBe(200);
    expect(res.body.resourceGroupName).toBe('rg-demo');
    expect(res.body.machineCount).toBeGreaterThan(0);
  });

  it('should return all groups when id is all', async () => {
    const res = await request(app).get('/api/groups/all/compliance');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('POST /api/export/checklist', () => {
  it('should return a .ckl XML file', async () => {
    const machineId = mockStore.machines[0]?.id;
    const res = await request(app)
      .post('/api/export/checklist')
      .send({ machineId, format: 'ckl' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('xml');
    expect(res.text).toContain('<CHECKLIST>');
  });

  it('should return JSON when format=json', async () => {
    const machineId = mockStore.machines[0]?.id;
    const res = await request(app)
      .post('/api/export/checklist')
      .send({ machineId, format: 'json' });
    expect(res.status).toBe(200);
    expect(res.body.findings).toBeDefined();
  });

  it('should return CSV when format=csv', async () => {
    const machineId = mockStore.machines[0]?.id;
    const res = await request(app)
      .post('/api/export/checklist')
      .send({ machineId, format: 'csv' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('csv');
    expect(res.text).toContain('VulnID');
  });

  it('should return 400 when machineId is missing', async () => {
    const res = await request(app)
      .post('/api/export/checklist')
      .send({ format: 'ckl' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/scan/trigger', () => {
  it('should accept a scan trigger request', async () => {
    const res = await request(app)
      .post('/api/scan/trigger')
      .send({ subscriptionIds: ['mock-sub-001'] });
    expect(res.status).toBe(202);
    expect(res.body.scanId).toBeTruthy();
  });
});

describe('/api/emass/config', () => {
  afterAll(async () => {
    await request(app).delete('/api/emass/config');
  });

  it('saves configuration without returning secret values', async () => {
    const saved = await request(app)
      .put('/api/emass/config')
      .send({
        baseUrl: 'https://emass.example.mil',
        userUid: 'CN=Test User',
        apiKey: 'secret-api-key',
        certPem: '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----',
        keyPem: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
      });

    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      configured: true,
      source: 'saved',
      apiKeyConfigured: true,
      certPemConfigured: true,
      keyPemConfigured: true,
    });
    expect(JSON.stringify(saved.body)).not.toContain('secret-api-key');
    expect(JSON.stringify(saved.body)).not.toContain('PRIVATE KEY');

    const retained = await request(app)
      .put('/api/emass/config')
      .send({ baseUrl: 'https://emass.example.mil/api', userUid: 'CN=Test User', apiKey: '', certPem: '', keyPem: '' });
    expect(retained.status).toBe(200);
    expect(retained.body.configured).toBe(true);
  });

  it('rejects non-HTTPS endpoints and invalid PEM values', async () => {
    const insecure = await request(app)
      .put('/api/emass/config')
      .send({ baseUrl: 'http://emass.example.mil', userUid: 'test' });
    expect(insecure.status).toBe(400);

    const invalidPem = await request(app)
      .put('/api/emass/config')
      .send({ baseUrl: 'https://emass.example.mil', userUid: 'test', certPem: 'not a certificate' });
    expect(invalidPem.status).toBe(400);
  });
});

describe('/api/scan/schedule', () => {
  it('reads and updates the automatic scan schedule', async () => {
    const initial = await request(app).get('/api/scan/schedule');
    expect(initial.status).toBe(200);
    expect(initial.body).toHaveProperty('nextRunAt');

    const updated = await request(app)
      .put('/api/scan/schedule')
      .send({
        enabled: true,
        frequency: 'daily',
        minute: 30,
        hour: 6,
        dayOfWeek: 1,
        timeZone: 'America/Chicago',
      });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      enabled: true,
      frequency: 'daily',
      minute: 30,
      hour: 6,
      timeZone: 'America/Chicago',
    });
    expect(updated.body.nextRunAt).toBeTruthy();
  });

  it('rejects invalid schedule values', async () => {
    const response = await request(app)
      .put('/api/scan/schedule')
      .send({
        enabled: true,
        frequency: 'daily',
        minute: 99,
        hour: 6,
        dayOfWeek: 1,
        timeZone: 'UTC',
      });
    expect(response.status).toBe(400);
  });
});
