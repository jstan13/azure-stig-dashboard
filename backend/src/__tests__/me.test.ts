import express from 'express';
import request from 'supertest';

jest.mock('../database/dataSource', () => ({
  AppDataSource: { getRepository: jest.fn(), isInitialized: true },
  mockStore: {},
}));
jest.mock('../middleware/authz', () => ({
  resolveRoles: jest.fn(async () => ({ global: new Set(['isso']), byCollection: new Map() })),
}));

import { AppDataSource } from '../database/dataSource';
import meRouter from '../routes/me';

const principal = { objectId: 'oid-b', upn: 'a@example.com', name: 'B', appRoles: [], groups: [], groupsOverage: false };

function buildApp() {
  const app = express();
  app.use((req, _res, next) => { (req as any).principal = principal; next(); });
  app.use('/api/me', meRouter);
  return app;
}

describe('GET /api/me directory registration', () => {
  const getRepository = AppDataSource.getRepository as jest.Mock;
  let repo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };

  function withRows(rows: any[]) {
    repo = {
      findOne: jest.fn(async ({ where }) => rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null),
      create: jest.fn((v) => ({ ...v })),
      save: jest.fn(async (v) => v),
    };
    getRepository.mockReturnValue(repo);
  }

  it('does not re-enable a disabled user who signs in again', async () => {
    withRows([{ oid: 'oid-b', email: 'a@example.com', isActive: false, roles: ['issm'] }]);
    await request(buildApp()).get('/api/me').expect(200);
    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ isActive: false, roles: ['issm'] }));
  });

  it('does not move a disabled row to another identity sharing its email', async () => {
    const disabled = { oid: 'oid-a', email: 'a@example.com', isActive: false };
    withRows([disabled]);
    await request(buildApp()).get('/api/me').expect(200);
    expect(repo.save).not.toHaveBeenCalled();
    expect(disabled.oid).toBe('oid-a');
  });

  it('registers a new user as enabled', async () => {
    withRows([]);
    await request(buildApp()).get('/api/me').expect(200);
    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ oid: 'oid-b', isActive: true, roles: ['isso'] }));
  });
});
