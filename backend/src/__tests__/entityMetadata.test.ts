import { AppDataSource } from '../database/dataSource';

describe('PostgreSQL entity metadata', () => {
  it('builds metadata for every registered entity', async () => {
    const metadataBuilder = AppDataSource as unknown as {
      buildMetadatas(): Promise<void>;
    };

    await expect(metadataBuilder.buildMetadatas()).resolves.toBeUndefined();
  });
});