import express from 'express';
import request from 'supertest';

jest.mock('../database/dataSource', () => ({
  AppDataSource: { getRepository: jest.fn(), query: jest.fn(), transaction: jest.fn() },
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

describe('POST /api/poams/bulk-create (database)', () => {
  const getRepository = AppDataSource.getRepository as jest.Mock;
  const query = AppDataSource.query as jest.Mock;
  const transaction = AppDataSource.transaction as jest.Mock;
  const year = new Date().getFullYear();
  let qb: Record<string, jest.Mock>;
  let txSave: jest.Mock;

  const finding = (id: string, severity: string) => ({
    id, severity, controlId: `ctl-${id}`, machineId: 'mac-1',
    control: { title: `Control ${id}`, description: `Fix ${id}` },
    machine: { name: 'GOV-DC-01' },
  });

  beforeEach(() => {
    process.env.MOCK_MODE = 'false';
    getRepository.mockReset();
    query.mockReset();
    transaction.mockReset();
    qb = {} as Record<string, jest.Mock>;
    for (const m of ['innerJoinAndSelect', 'leftJoinAndSelect', 'where', 'andWhere']) qb[m] = jest.fn(() => qb);
    qb.getMany = jest.fn();
    txSave = jest.fn(async (rows) => rows.map((r: any, i: number) => ({ id: `id-${i}`, ...r })));
    const poamRepo = { create: jest.fn((v) => ({ ...v })) };
    getRepository.mockImplementation((entity) =>
      entity === PoamEntity ? poamRepo : { createQueryBuilder: jest.fn(() => qb) });
    transaction.mockImplementation(async (fn) => fn({ getRepository: () => ({ save: txSave }) }));
  });

  afterAll(() => {
    process.env.MOCK_MODE = 'true';
  });

  it('creates POA&Ms for open findings on active machines, numbered after the highest id', async () => {
    qb.getMany.mockResolvedValueOnce([finding('a', 'high'), finding('b', 'high')]);
    query.mockResolvedValueOnce([{ max: 12 }]);

    const res = await request(buildApp()).post('/api/poams/bulk-create').send({ severity: 'high' });

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(2);
    expect(res.body.poams.map((p: any) => p.poamId)).toEqual([`POA-${year}-0013`, `POA-${year}-0014`]);
    expect(res.body.poams[0]).toMatchObject({
      findingId: 'a', weakness: 'Control a', severity: 'high', impact: 'CAT I finding on GOV-DC-01', createdByOid: 'test-oid',
    });
    const conditions = qb.andWhere.mock.calls.map((c) => c[0]);
    expect(conditions).toEqual(expect.arrayContaining([
      'm.isActive = :isActive',
      expect.stringContaining('NOT EXISTS'),
      'f.severity = :severity',
    ]));
  });

  it('renumbers the whole batch when another create took one of its ids', async () => {
    qb.getMany.mockResolvedValueOnce([finding('a', 'low')]);
    query.mockResolvedValueOnce([{ max: 1 }]).mockResolvedValueOnce([{ max: 2 }]);
    txSave.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));

    const res = await request(buildApp()).post('/api/poams/bulk-create').send({});

    expect(res.status).toBe(201);
    expect(res.body.poams[0].poamId).toBe(`POA-${year}-0003`);
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('creates nothing when no machine id could exist, without querying', async () => {
    const res = await request(buildApp()).post('/api/poams/bulk-create').send({ machineIds: ['not-a-uuid'] });

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(0);
    expect(qb.getMany).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/poams/:id (database)', () => {
  const getRepository = AppDataSource.getRepository as jest.Mock;
  let repo: { findOne: jest.Mock; save: jest.Mock };

  beforeEach(() => {
    process.env.MOCK_MODE = 'false';
    getRepository.mockReset();
    repo = { findOne: jest.fn(), save: jest.fn(async (v) => v) };
    getRepository.mockReturnValue(repo);
  });

  afterAll(() => {
    process.env.MOCK_MODE = 'true';
  });

  it('looks up a POA-style id without comparing it to the uuid column', async () => {
    repo.findOne.mockResolvedValueOnce({ id: 'u1', poamId: 'POA-2026-0001', findingId: null, severity: 'low' });

    const res = await request(buildApp()).patch('/api/poams/POA-2026-0001').send({ controlAcronym: 'ac-2' });

    expect(res.status).toBe(200);
    expect(repo.findOne).toHaveBeenCalledWith({ where: [{ poamId: 'POA-2026-0001' }] });
    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ controlAcronym: 'AC-2' }));
  });

  it('will not rewrite the rationale of an approved risk acceptance', async () => {
    repo.findOne.mockResolvedValueOnce({
      id: '0f8fad5b-d9cb-469f-a165-70867728950e', approvedAt: new Date(), riskAcceptanceRationale: 'Signed off',
    });

    const res = await request(buildApp())
      .patch('/api/poams/0f8fad5b-d9cb-469f-a165-70867728950e')
      .send({ riskAcceptanceRationale: 'Something else' });

    expect(res.status).toBe(409);
    expect(repo.save).not.toHaveBeenCalled();
  });
});
