import { ResourceGraphConnector } from '../connectors/resourceGraphConnector';
import { PolicyConnector } from '../connectors/policyConnector';
import { DefenderConnector } from '../connectors/defenderConnector';
import { ARMConnector } from '../connectors/armConnector';
import { mockStore } from '../../database/dataSource';
import { seedMock } from '../../database/mockSeed';

// Seed mock data before tests
beforeAll(() => {
  seedMock(mockStore);
});

describe('ResourceGraphConnector (mock mode)', () => {
  const connector = new ResourceGraphConnector();

  it('should return machine inventory from mock store', async () => {
    const result = await connector.scan();
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.source).toBe('resource-graph-mock');
  });

  it('each entry should have required fields', async () => {
    const result = await connector.scan();
    for (const entry of result.data) {
      expect(entry.id).toBeTruthy();
      expect(entry.name).toBeTruthy();
      expect(entry.subscriptionId).toBeTruthy();
      expect(entry.resourceGroupName).toBeTruthy();
    }
  });

  it('should return a scannedAt timestamp', async () => {
    const result = await connector.scan();
    expect(result.scannedAt).toBeInstanceOf(Date);
  });
});

describe('PolicyConnector (mock mode)', () => {
  const connector = new PolicyConnector();

  it('should return policy compliance results', async () => {
    const result = await connector.scan();
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.source).toBe('policy-mock');
  });

  it('each policy result should have a compliance state', async () => {
    const result = await connector.scan();
    const validStates = ['Compliant', 'NonCompliant', 'Unknown', 'Exempt', 'Conflict'];
    for (const entry of result.data) {
      expect(validStates).toContain(entry.complianceState);
    }
  });
});

describe('DefenderConnector (mock mode)', () => {
  const connector = new DefenderConnector();

  it('should return Defender assessment results', async () => {
    const result = await connector.scan();
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.source).toBe('defender-mock');
  });

  it('each assessment should have a status', async () => {
    const result = await connector.scan();
    const validStatuses = ['Healthy', 'Unhealthy', 'NotApplicable', 'Unknown'];
    for (const entry of result.data) {
      expect(validStatuses).toContain(entry.status);
    }
  });
});

describe('ARMConnector (mock mode)', () => {
  const connector = new ARMConnector();

  it('should return VM metadata', async () => {
    const result = await connector.scan();
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.source).toBe('arm-mock');
  });

  it('VMs should include OS information', async () => {
    const result = await connector.scan();
    for (const vm of result.data) {
      expect(vm.osType).toBeTruthy();
    }
  });
});
