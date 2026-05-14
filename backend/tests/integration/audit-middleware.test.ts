/**
 * Integration tests for the audit + correlation middleware wired into
 * `backend/src/index.ts` (T019 + Principle II / FR-003).
 *
 * Exercises the real Express app in MOCK_MODE so no DB is required:
 *   - every authenticated request gets an `x-correlation-id` response header
 *   - inbound `x-correlation-id` is echoed back unchanged
 *   - `req.audit` is wired and writes flow into the in-memory mock writer
 *
 * These tests can be run as part of `npm test --workspace=backend` in CI
 * (GitHub Actions workflow `.github/workflows/deploy.yml`) and against any
 * Azure-deployed instance via the smoke step in that workflow.
 */
import request from 'supertest';
import app from '../../src/index';
import { mockAuditWriter } from '../../src/auth/writers';
import { mockStore } from '../../src/database/dataSource';
import { seedMock } from '../../src/database/mockSeed';

beforeAll(() => {
  seedMock(mockStore);
});

describe('audit + correlation middleware', () => {
  beforeEach(() => {
    // Drain any prior audit emissions so assertions are isolated.
    mockAuditWriter.entries.length = 0;
  });

  it('echoes an inbound x-correlation-id back on the response', async () => {
    const res = await request(app)
      .get('/api/machines')
      .set('x-correlation-id', 'test-corr-echo');
    expect(res.status).toBe(200);
    expect(res.headers['x-correlation-id']).toBe('test-corr-echo');
  });

  it('generates a fresh correlation ID when none is supplied', async () => {
    const res = await request(app).get('/api/machines');
    expect(res.status).toBe(200);
    const id = res.headers['x-correlation-id'];
    expect(typeof id).toBe('string');
    // RFC 4122 v4 shape (length 36, four hyphens)
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('does not stamp a correlation ID on /health (public route)', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    // Public routes do not flow through auditMiddleware.
    expect(res.headers['x-correlation-id']).toBeUndefined();
  });

  it('records a Success audit entry when POST /api/export/checklist succeeds', async () => {
    const machineId = mockStore.machines[0]?.id;
    expect(machineId).toBeTruthy();

    const res = await request(app)
      .post('/api/export/checklist')
      .set('x-correlation-id', 'corr-export-1')
      .send({ machineId, format: 'json' });

    expect(res.status).toBe(200);

    const entry = mockAuditWriter.entries.find(
      (e) => e.correlationId === 'corr-export-1',
    );
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      action: 'checklist.exported',
      entityType: 'machine',
      entityId: machineId,
      result: 'Success',
    });
  });
});
