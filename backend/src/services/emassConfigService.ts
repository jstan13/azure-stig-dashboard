import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { AppDataSource } from '../database/dataSource';
import { EmassConfigEntity } from '../models/EmassConfig';

export interface EffectiveEmassConfig {
  baseUrl: string;
  apiKey: string;
  userUid: string;
  certPem: string;
  keyPem: string;
  caPem?: string;
}

export interface EmassConfigInput {
  baseUrl?: string;
  userUid?: string;
  apiKey?: string;
  certPem?: string;
  keyPem?: string;
  caPem?: string | null;
}

const ENV_KEYS = {
  baseUrl: 'EMASS_BASE_URL',
  apiKey: 'EMASS_API_KEY',
  userUid: 'EMASS_USER_UID',
  certPem: 'EMASS_CERT_PEM',
  keyPem: 'EMASS_KEY_PEM',
  caPem: 'EMASS_CA_PEM',
} as const;

let mockSavedConfig: EmassConfigEntity | null = null;
const isMock = () => process.env.MOCK_MODE === 'true';

function encryptionKey(): Buffer {
  const root = process.env.EMASS_CONFIG_ENCRYPTION_KEY
    || process.env.AZURE_CLIENT_SECRET
    || process.env.DB_PASSWORD;
  if (!root) {
    throw new Error('EMASS_CONFIG_ENCRYPTION_KEY must be set before saving eMASS credentials');
  }
  return createHash('sha256').update(`stig-dashboard:emass:v1:${root}`).digest();
}

export function encryptEmassSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join(':');
}

export function decryptEmassSecret(value: string): string {
  const [version, iv, tag, encrypted] = value.split(':');
  if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('Stored eMASS credential is invalid');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

async function savedConfig(): Promise<EmassConfigEntity | null> {
  if (isMock()) return mockSavedConfig;
  if (!AppDataSource.isInitialized) return null;
  return AppDataSource.getRepository(EmassConfigEntity).findOne({ where: { id: 'singleton' } });
}

function env(name: keyof typeof ENV_KEYS): string | undefined {
  return process.env[ENV_KEYS[name]]?.trim() || undefined;
}

function savedSecret(value: string | null | undefined): string | undefined {
  return value ? decryptEmassSecret(value) : undefined;
}

export async function getEffectiveEmassConfig(): Promise<EffectiveEmassConfig> {
  const saved = await savedConfig();
  const values = {
    baseUrl: saved?.baseUrl?.trim() || env('baseUrl'),
    apiKey: savedSecret(saved?.apiKeyEncrypted) || env('apiKey'),
    userUid: saved?.userUid?.trim() || env('userUid'),
    certPem: savedSecret(saved?.certPemEncrypted) || env('certPem'),
    keyPem: savedSecret(saved?.keyPemEncrypted) || env('keyPem'),
    caPem: savedSecret(saved?.caPemEncrypted) || env('caPem'),
  };
  const missing = (Object.keys(ENV_KEYS) as Array<keyof typeof ENV_KEYS>)
    .filter((key) => key !== 'caPem' && !values[key]);
  if (missing.length) {
    throw new Error(`eMASS connector not configured. Missing settings: ${missing.join(', ')}`);
  }
  return {
    baseUrl: values.baseUrl!.replace(/\/$/, ''),
    apiKey: values.apiKey!,
    userUid: values.userUid!,
    certPem: values.certPem!,
    keyPem: values.keyPem!,
    caPem: values.caPem,
  };
}

export async function getEmassConfigStatus() {
  const saved = await savedConfig();
  const present = {
    baseUrl: !!(saved?.baseUrl?.trim() || env('baseUrl')),
    apiKey: !!(saved?.apiKeyEncrypted || env('apiKey')),
    userUid: !!(saved?.userUid?.trim() || env('userUid')),
    certPem: !!(saved?.certPemEncrypted || env('certPem')),
    keyPem: !!(saved?.keyPemEncrypted || env('keyPem')),
    caPem: !!(saved?.caPemEncrypted || env('caPem')),
  };
  return {
    baseUrl: saved?.baseUrl || env('baseUrl') || '',
    userUid: saved?.userUid || env('userUid') || '',
    ...Object.fromEntries(Object.entries(present).map(([key, value]) => [`${key}Configured`, value])),
    configured: present.baseUrl && present.apiKey && present.userUid && present.certPem && present.keyPem,
    source: saved ? 'saved' : Object.values(present).some(Boolean) ? 'environment' : 'none',
    updatedAt: saved?.updatedAt || null,
  };
}

export async function saveEmassConfig(input: EmassConfigInput): Promise<void> {
  if (!isMock() && !AppDataSource.isInitialized) throw new Error('Database is not available');
  const repo = isMock() ? null : AppDataSource.getRepository(EmassConfigEntity);
  const config = await savedConfig()
    || (repo ? repo.create({ id: 'singleton' }) : Object.assign(new EmassConfigEntity(), { id: 'singleton' }));

  if (input.baseUrl !== undefined) config.baseUrl = input.baseUrl.trim() || null;
  if (input.userUid !== undefined) config.userUid = input.userUid.trim() || null;
  if (input.apiKey?.trim()) config.apiKeyEncrypted = encryptEmassSecret(input.apiKey.trim());
  if (input.certPem?.trim()) config.certPemEncrypted = encryptEmassSecret(input.certPem.trim());
  if (input.keyPem?.trim()) config.keyPemEncrypted = encryptEmassSecret(input.keyPem.trim());
  if (input.caPem === null) config.caPemEncrypted = null;
  else if (input.caPem?.trim()) config.caPemEncrypted = encryptEmassSecret(input.caPem.trim());

  if (repo) await repo.save(config);
  else {
    const now = new Date();
    config.createdAt ||= now;
    config.updatedAt = now;
    mockSavedConfig = config;
  }
}

export async function clearSavedEmassConfig(): Promise<void> {
  if (isMock()) {
    mockSavedConfig = null;
    return;
  }
  if (!AppDataSource.isInitialized) throw new Error('Database is not available');
  await AppDataSource.getRepository(EmassConfigEntity).delete({ id: 'singleton' });
}