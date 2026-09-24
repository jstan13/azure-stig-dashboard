/**
 * Access-control regressions.
 *
 * `GET /api/notifications/configs` returns `destination`, which for the
 * teams_webhook channel is a webhook URL whose embedded token is itself the
 * credential needed to post into the channel. It must not be readable by the
 * low-privilege auditor role.
 */
import request from 'supertest';
import express from 'express';
import axios from 'axios';
import app from '../index';
import { mockStore } from '../database/dataSource';
import { seedMock } from '../database/mockSeed';
import machinesRouter from '../routes/machines';
import hierarchyRouter from '../routes/hierarchy';
import vulnerabilitiesRouter from '../routes/vulnerabilities';

const originalRole = process.env.MOCK_ROLE;

beforeAll(() => {
  seedMock(mockStore);
});

afterEach(() => {
  if (originalRole === undefined) delete process.env.MOCK_ROLE;
  else process.env.MOCK_ROLE = originalRole;
});

describe('GET /api/notifications/configs', () => {
  it('denies an auditor, who must not read webhook destinations', async () => {
    process.env.MOCK_ROLE = 'auditor';
    const res = await request(app).get('/api/notifications/configs');
    expect(res.status).toBe(403);
  });

  it('denies an operator', async () => {
    process.env.MOCK_ROLE = 'operator';
    const res = await request(app).get('/api/notifications/configs');
    expect(res.status).toBe(403);
  });

  it('allows an admin', async () => {
    process.env.MOCK_ROLE = 'admin';
    const res = await request(app).get('/api/notifications/configs');
    expect(res.status).toBe(200);
  });
});

describe('POST /api/notifications/test/:id', () => {
  const token = 'sig=SECRET-SAS-TOKEN-123';
  const configId = 'notif-test-mask';

  beforeAll(() => {
    mockStore.notificationConfigs.push({
      id: configId,
      trigger: 'scan_complete',
      channel: 'teams_webhook',
      destination: `https://prod-01.eastus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?${token}`,
      enabled: true,
    });
  });

  afterAll(() => {
    mockStore.notificationConfigs = mockStore.notificationConfigs.filter((c: any) => c.id !== configId);
    jest.restoreAllMocks();
  });

  it('never writes the webhook token to the audit log or response', async () => {
    jest.spyOn(axios, 'post').mockResolvedValue({ data: {} } as any);
    process.env.MOCK_ROLE = 'admin';

    const res = await request(app).post(`/api/notifications/test/${configId}`);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('SECRET-SAS-TOKEN');
    const audit = mockStore.auditLogs.find((e: any) => e.action === 'notification_config.tested' && e.targetId === configId);
    expect(audit).toBeDefined();
    expect(JSON.stringify(audit)).not.toContain('SECRET-SAS-TOKEN');
  });
});

describe('PATCH /api/notifications/configs/:id', () => {
  const configId = 'notif-legacy-destination';

  beforeAll(() => {
    // Created before destination validation existed; the host is not allow-listed.
    mockStore.notificationConfigs.push({
      id: configId,
      trigger: 'scan_complete',
      channel: 'teams_webhook',
      destination: 'https://legacy.example.com/hook',
      enabled: true,
    });
  });

  afterAll(() => {
    mockStore.notificationConfigs = mockStore.notificationConfigs.filter((c: any) => c.id !== configId);
  });

  it('can still disable a config whose stored destination no longer validates', async () => {
    process.env.MOCK_ROLE = 'admin';
    const res = await request(app).patch(`/api/notifications/configs/${configId}`).send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
  });

  it('rejects changing the destination to a disallowed host', async () => {
    process.env.MOCK_ROLE = 'admin';
    const res = await request(app)
      .patch(`/api/notifications/configs/${configId}`)
      .send({ destination: 'https://169.254.169.254/latest' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/users/:id', () => {
  it("denies a non-admin reading another user's record", async () => {
    process.env.MOCK_ROLE = 'auditor';
    const res = await request(app).get('/api/users/user-001');
    expect(res.status).toBe(403);
  });

  it('allows an admin', async () => {
    process.env.MOCK_ROLE = 'admin';
    const res = await request(app).get('/api/users/user-001');
    expect(res.status).toBe(200);
  });
});

/**
 * A valid token proves identity, not entitlement. If the app registration does
 * not require assignment, any tenant user gets a token with zero app roles, so
 * read routes must still check `dashboard:read`.
 */
describe('read routes reject a principal with no app roles', () => {
  const buildApp = (appRoles: string[]) => {
    const a = express();
    a.use((req, _res, next) => {
      (req as any).principal = { objectId: 'test-oid', appRoles, groups: [] };
      next();
    });
    a.use('/api/machines', machinesRouter);
    a.use('/api/hierarchy', hierarchyRouter);
    a.use('/api/vulnerabilities', vulnerabilitiesRouter);
    return a;
  };

  const paths = ['/api/machines', '/api/hierarchy/kpis', '/api/vulnerabilities/summary'];

  it.each(paths)('denies %s when the caller holds no role', async (path) => {
    const res = await request(buildApp([])).get(path);
    expect(res.status).toBe(403);
  });

  it.each(paths)('still allows %s for an auditor', async (path) => {
    const res = await request(buildApp(['auditor'])).get(path);
    expect(res.status).toBe(200);
  });
});
