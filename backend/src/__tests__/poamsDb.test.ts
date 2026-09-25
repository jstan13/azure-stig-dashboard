import express from 'express';
import request from 'supertest';

jest.mock('../database/dataSource', () => ({
  AppDataSource: { getRepository: jest.fn(), query: jest.fn() },
  mockStore: {},
}));
jest.mock('../auth', () => ({
  ...jest.requireActual('../auth'),
  recordAudit: jest.fn().mockResolvedValue(undefined),
}));

import { AppDataSource } from '../database/dataSource';
import { PoamEntity } from '../models/Poam';
import { FindingEntity } from '../models/Finding';
import { errorHandler } from '../middleware/errorHandler';
import poamsRouter from '../routes/poams';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).principal = { objectId: 'test-oid', appRoles: ['admin'], groups: [] };
    (req as any).auth = { oid: 'test-oid' };
    next();
  });
  app.use('/api/poams', poamsRouter);
  app.use(errorHandler);
  return app;
}

describe('POST /api/poams (database)', () => {
  const getRepository = AppDataSource.getRepository as jest.Mock;
  const query = AppDataSource.query as jest.Mock;
  const year = new Date().getFullYear();
  let poamRepo: { create: jest.Mock; save: jest.Mock };
  let findingRepo: { findOne: jest.Mock };

  beforeEach(() => {
    process.env.MOCK_MODE = 'false';
    getRepository.mockReset();
    query.mockReset();
    poamRepo = {
      create: jest.fn((v) => ({ ...v })),
      save: jest.fn(async (v) => ({ id: 'new-uuid', ...v })),
    };
    findingRepo = { findOne: jest.fn() };
    getRepository.mockImplementation((entity) => (entity === PoamEntity ? poamRepo : findingRepo));
  });

  afterAll(() => {
    process.env.MOCK_MODE = 'true';
  });

  it('numbers from the highest stored id so restarts do not reuse ids', async () => {
    query.mockResolvedValueOnce([{ max: 41 }]);

    const res = await request(buildApp()).post('/api/poams').send({
      weakness: 'Assessment finding', severity: 'low', controlAcronym: 'cm-6',
    });

    expect(res.status).toBe(201);
    expect(res.body.poamId).toBe(`POA-${year}-0042`);
    expect(query.mock.calls[0][1]).toEqual([`^POA-${year}-[0-9]+$`]);
    expect(poamRepo.create).toHaveBeenCalledWith(expect.objectContaining({
      findingId: null, severity: 'low', controlAcronym: 'CM-6', createdByOid: 'test-oid',
    }));
    expect(findingRepo.findOne).not.toHaveBeenCalled();
  });

  it('retries with a fresh id when a concurrent create took the same one', async () => {
    query.mockResolvedValueOnce([{ max: 7 }]).mockResolvedValueOnce([{ max: 8 }]);
    poamRepo.save
      .mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { driverError: { code: '23505' } }))
      .mockImplementationOnce(async (v) => ({ id: 'new-uuid', ...v }));

    const res = await request(buildApp()).post('/api/poams').send({ weakness: 'Race', severity: 'high' });

    expect(res.status).toBe(201);
    expect(res.body.poamId).toBe(`POA-${year}-0009`);
    expect(poamRepo.save).toHaveBeenCalledTimes(2);
  });

  it('derives severity from a linked finding', async () => {
    const findingId = '0f8fad5b-d9cb-469f-a165-70867728950e';
    query.mockResolvedValueOnce([{ max: 0 }]);
    findingRepo.findOne.mockResolvedValueOnce({ id: findingId, severity: 'high' });

    const res = await request(buildApp()).post('/api/poams').send({ findingId, weakness: 'Linked' });

    expect(res.status).toBe(201);
    expect(res.body.poamId).toBe(`POA-${year}-0001`);
    expect(res.body.severity).toBe('high');
    expect(findingRepo.findOne).toHaveBeenCalledWith({ where: { id: findingId } });
    expect(getRepository).toHaveBeenCalledWith(FindingEntity);
  });

  it('returns 404 for a non-UUID finding id without querying Postgres', async () => {
    const res = await request(buildApp()).post('/api/poams').send({ findingId: 'not-a-uuid', weakness: 'x' });

    expect(res.status).toBe(404);
    expect(findingRepo.findOne).not.toHaveBeenCalled();
  });
});
