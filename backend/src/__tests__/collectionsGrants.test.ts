import express from 'express';
import request from 'supertest';

jest.mock('../database/dataSource', () => ({
  AppDataSource: { getRepository: jest.fn(), isInitialized: true },
  mockStore: {},
}));
jest.mock('../middleware/authz', () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  invalidateAuthzCache: jest.fn(),
  // A collection-scoped ISSM: holds roles:assign only inside col-a.
  resolveRoles: jest.fn(async () => ({ global: new Set(), byCollection: new Map([['col-a', new Set(['issm'])]]) })),
}));
jest.mock('../auth', () => ({ recordAudit: jest.fn().mockResolvedValue(undefined) }));

import { AppDataSource } from '../database/dataSource';
import { errorHandler } from '../middleware/errorHandler';
import collectionsRouter from '../routes/collections';

const principal = { objectId: 'oid-issm', appRoles: [], groups: ['grp-mine'], groupsOverage: false };

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).principal = principal; next(); });
  app.use('/api/collections', collectionsRouter);
  app.use(errorHandler);
  return app;
}

describe('role assignment limits', () => {
  const getRepository = AppDataSource.getRepository as jest.Mock;
  let prevMock: string | undefined;

  beforeAll(() => { prevMock = process.env.MOCK_MODE; process.env.MOCK_MODE = 'false'; });
  afterAll(() => { process.env.MOCK_MODE = prevMock; });

  beforeEach(() => {
    getRepository.mockReturnValue({
      findOne: jest.fn(async ({ where }) => (where?.id === 'col-a' ? { id: 'col-a' } : null)),
      create: jest.fn((v) => ({ id: 'new', ...v })),
      save: jest.fn(async (v) => v),
    });
  });

  it.each([
    ['a global admin binding', { subjectOid: 'oid-x', role: 'admin' }],
    ['a global auditor binding', { subjectOid: 'oid-x', role: 'auditor' }],
    ['admin in its own collection', { subjectOid: 'oid-x', role: 'admin', collectionId: 'col-a' }],
    ['a binding to itself', { subjectOid: 'oid-issm', role: 'issm', collectionId: 'col-a' }],
  ])('refuses %s', async (_label, body) => {
    await request(buildApp()).post('/api/collections/role-bindings').send(body).expect(403);
  });

  it('allows an ISSO binding in its own collection', async () => {
    await request(buildApp()).post('/api/collections/role-bindings')
      .send({ subjectOid: 'oid-x', role: 'isso', collectionId: 'col-a' }).expect(201);
  });

  it('refuses to map a role to a group the caller belongs to', async () => {
    await request(buildApp()).post('/api/collections/group-mappings')
      .send({ groupObjectId: 'grp-mine', role: 'isso', collectionId: 'col-a' }).expect(403);
  });

  it('refuses a global group mapping from a collection-scoped ISSM', async () => {
    await request(buildApp()).post('/api/collections/group-mappings')
      .send({ groupObjectId: 'grp-other', role: 'admin' }).expect(403);
  });
});
