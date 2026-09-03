import express from 'express';
import request from 'supertest';

jest.mock('../database/dataSource', () => ({
  AppDataSource: { getRepository: jest.fn() },
}));

import { AppDataSource } from '../database/dataSource';
import { StigBenchmarkEntity } from '../models/StigBenchmark';
import { StigVersionEntity } from '../models/StigVersion';
import { ControlEntity } from '../models/Control';
import { errorHandler } from '../middleware/errorHandler';
import stigsRouter from '../routes/stigs';

describe('STIG detail routes', () => {
  const getRepository = AppDataSource.getRepository as jest.Mock;
  const benchmark = {
    id: '727d0908-72ae-469a-bc3f-8cd1aa93e324',
    benchmarkId: 'Active_Directory_Forest',
    title: 'Active Directory Forest',
  };

  beforeEach(() => {
    process.env.MOCK_MODE = 'false';
    getRepository.mockReset();
  });

  afterAll(() => {
    process.env.MOCK_MODE = 'true';
  });

  it('queries version history using the benchmark UUID', async () => {
    const benchmarkRepo = { findOne: jest.fn().mockResolvedValue(benchmark) };
    const versionRepo = { find: jest.fn().mockResolvedValue([]) };
    getRepository.mockImplementation((entity) => {
      if (entity === StigBenchmarkEntity) return benchmarkRepo;
      if (entity === StigVersionEntity) return versionRepo;
      throw new Error('Unexpected repository');
    });

    const app = express();
    app.use('/api/stigs', stigsRouter);
    app.use(errorHandler);

    const response = await request(app).get('/api/stigs/Active_Directory_Forest');

    expect(response.status).toBe(200);
    expect(versionRepo.find).toHaveBeenCalledWith(expect.objectContaining({
      where: { benchmarkId: benchmark.id },
    }));
  });

  it('resolves controls using the benchmark UUID', async () => {
    const benchmarkRepo = { findOne: jest.fn().mockResolvedValue(benchmark) };
    const versionRepo = {
      findOne: jest.fn().mockResolvedValue({ id: 'stig-version-uuid' }),
    };
    const queryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    const controlRepo = { createQueryBuilder: jest.fn().mockReturnValue(queryBuilder) };
    getRepository.mockImplementation((entity) => {
      if (entity === StigBenchmarkEntity) return benchmarkRepo;
      if (entity === StigVersionEntity) return versionRepo;
      if (entity === ControlEntity) return controlRepo;
      throw new Error('Unexpected repository');
    });

    const app = express();
    app.use('/api/stigs', stigsRouter);
    app.use(errorHandler);

    const response = await request(app)
      .get('/api/stigs/Active_Directory_Forest/controls?page=1&pageSize=100');

    expect(response.status).toBe(200);
    expect(versionRepo.findOne).toHaveBeenCalledWith(expect.objectContaining({
      where: { benchmarkId: benchmark.id, status: 'active' },
    }));
  });
});