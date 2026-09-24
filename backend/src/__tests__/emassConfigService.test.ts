import {
  decryptEmassSecret, encryptEmassSecret,
} from '../services/emassConfigService';

describe('eMASS configuration encryption', () => {
  const originalKey = process.env.EMASS_CONFIG_ENCRYPTION_KEY;
  const originalClientSecret = process.env.AZURE_CLIENT_SECRET;
  const originalDbPassword = process.env.DB_PASSWORD;
  const originalMockMode = process.env.MOCK_MODE;

  beforeEach(() => {
    process.env.EMASS_CONFIG_ENCRYPTION_KEY = 'unit-test-key-one';
    process.env.MOCK_MODE = 'false';
  });

  afterAll(() => {
    if (originalMockMode === undefined) delete process.env.MOCK_MODE;
    else process.env.MOCK_MODE = originalMockMode;
    if (originalKey === undefined) delete process.env.EMASS_CONFIG_ENCRYPTION_KEY;
    else process.env.EMASS_CONFIG_ENCRYPTION_KEY = originalKey;
    if (originalClientSecret === undefined) delete process.env.AZURE_CLIENT_SECRET;
    else process.env.AZURE_CLIENT_SECRET = originalClientSecret;
    if (originalDbPassword === undefined) delete process.env.DB_PASSWORD;
    else process.env.DB_PASSWORD = originalDbPassword;
  });

  it('round-trips a secret without storing plaintext', () => {
    const plaintext = '-----BEGIN PRIVATE KEY-----\nsecret material\n-----END PRIVATE KEY-----';
    const encrypted = encryptEmassSecret(plaintext);

    expect(encrypted).not.toContain('secret material');
    expect(decryptEmassSecret(encrypted)).toBe(plaintext);
  });

  it('uses a unique nonce for each encryption', () => {
    expect(encryptEmassSecret('same value')).not.toBe(encryptEmassSecret('same value'));
  });

  it('rejects modified ciphertext', () => {
    const encrypted = encryptEmassSecret('sensitive');
    const tampered = `${encrypted.slice(0, -2)}AA`;
    expect(() => decryptEmassSecret(tampered)).toThrow();
  });

  it('rejects decryption with a different key', () => {
    const encrypted = encryptEmassSecret('sensitive');
    process.env.EMASS_CONFIG_ENCRYPTION_KEY = 'unit-test-key-two';
    expect(() => decryptEmassSecret(encrypted)).toThrow();
  });

  it('does not derive an encryption key from application credentials', () => {
    delete process.env.EMASS_CONFIG_ENCRYPTION_KEY;
    process.env.AZURE_CLIENT_SECRET = 'client-secret';
    process.env.DB_PASSWORD = 'database-password';

    expect(() => encryptEmassSecret('sensitive')).toThrow(
      'EMASS_CONFIG_ENCRYPTION_KEY must be set before saving eMASS credentials',
    );
  });

  it('refuses the Key Vault placeholder as a key', () => {
    process.env.EMASS_CONFIG_ENCRYPTION_KEY = 'not-configured';
    expect(() => encryptEmassSecret('sensitive')).toThrow(
      'EMASS_CONFIG_ENCRYPTION_KEY must be set before saving eMASS credentials',
    );
  });

  it('uses an ephemeral key in demo mode when none is configured', () => {
    process.env.MOCK_MODE = 'true';
    process.env.EMASS_CONFIG_ENCRYPTION_KEY = 'not-configured';

    const encrypted = encryptEmassSecret('demo value');
    expect(decryptEmassSecret(encrypted)).toBe('demo value');
  });
});
