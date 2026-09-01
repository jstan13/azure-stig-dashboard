import {
  decryptEmassSecret, encryptEmassSecret,
} from '../services/emassConfigService';

describe('eMASS configuration encryption', () => {
  const originalKey = process.env.EMASS_CONFIG_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.EMASS_CONFIG_ENCRYPTION_KEY = 'unit-test-key-one';
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.EMASS_CONFIG_ENCRYPTION_KEY;
    else process.env.EMASS_CONFIG_ENCRYPTION_KEY = originalKey;
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
});