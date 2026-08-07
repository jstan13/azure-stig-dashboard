import { DataSource } from 'typeorm';
import { SubscriptionEntity } from '../models/Subscription';
import { ResourceGroupEntity } from '../models/ResourceGroup';
import { ResourceEntity } from '../models/Resource';
import { MachineEntity } from '../models/Machine';
import { ControlEntity } from '../models/Control';
import { ControlMappingEntity } from '../models/ControlMapping';
import { ScanEntity } from '../models/Scan';
import { FindingEntity } from '../models/Finding';
import { ChecklistEntity } from '../models/Checklist';
import { UserEntity } from '../models/User';
import { RoleEntity } from '../models/Role';
import { ExceptionEntity } from '../models/Exception';
import { AuditLogEntity } from '../models/AuditLog';
import { StigBenchmarkEntity } from '../models/StigBenchmark';
import { StigVersionEntity } from '../models/StigVersion';
import { PowerStigResultEntity } from '../models/PowerStigResult';
import { PoamEntity, PoamMilestoneEntity } from '../models/Poam';
import { ComplianceHistoryEntity } from '../models/ComplianceHistory';
import { NotificationConfigEntity } from '../models/NotificationConfig';
import { RemediationJobEntity } from '../models/RemediationJob';
import { VulnerabilityEntity } from '../models/Vulnerability';
import { CollectionEntity } from '../models/Collection';
import { CollectionAssetEntity } from '../models/CollectionAsset';
import { RoleBindingEntity } from '../models/RoleBinding';
import { GroupRoleMappingEntity } from '../models/GroupRoleMapping';
import { AssetPoolEntity } from '../models/AssetPool';
import { AssetPoolMemberEntity } from '../models/AssetPoolMember';
import { ManualAnswerEntity } from '../models/ManualAnswer';

const isMockMode = process.env.MOCK_MODE === 'true';

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  host: !isMockMode ? (process.env.DB_HOST || 'localhost') : undefined,
  port: !isMockMode ? parseInt(process.env.DB_PORT || '5432') : undefined,
  username: !isMockMode ? process.env.DB_USER : undefined,
  password: !isMockMode ? process.env.DB_PASSWORD : undefined,
  database: !isMockMode ? (process.env.DB_NAME || 'stigdashboard') : undefined,
  synchronize: process.env.NODE_ENV === 'development',
  logging: process.env.DB_LOGGING === 'true',
  entities: [
    SubscriptionEntity,
    ResourceGroupEntity,
    ResourceEntity,
    MachineEntity,
    ControlEntity,
    ControlMappingEntity,
    ScanEntity,
    FindingEntity,
    ChecklistEntity,
    UserEntity,
    RoleEntity,
    ExceptionEntity,
    AuditLogEntity,
    StigBenchmarkEntity,
    StigVersionEntity,
    PowerStigResultEntity,
    PoamEntity,
    PoamMilestoneEntity,
    ComplianceHistoryEntity,
    NotificationConfigEntity,
    RemediationJobEntity,
    VulnerabilityEntity,
    CollectionEntity,
    CollectionAssetEntity,
    RoleBindingEntity,
    GroupRoleMappingEntity,
    AssetPoolEntity,
    AssetPoolMemberEntity,
    ManualAnswerEntity,
  ],
  migrations: ['dist/database/migrations/*.js'],
  migrationsTableName: 'migrations',
  ssl: buildDbSsl(),
});

/**
 * TLS settings for the Postgres connection.
 *
 * When DB_SSL=true we ALWAYS verify the server certificate (defends against
 * man-in-the-middle). Azure Database for PostgreSQL Flexible Server presents a
 * certificate chained to the DigiCert Global Root, which Node trusts via its
 * built-in CA store, so no extra config is needed for Azure.
 *
 * If you terminate TLS with a private CA, set DB_SSL_CA to the PEM bundle.
 * The only way to skip verification is to explicitly set
 * DB_SSL_REJECT_UNAUTHORIZED=false — never do this in production.
 */
function buildDbSsl(): false | { rejectUnauthorized: boolean; ca?: string } {
  if (process.env.DB_SSL !== 'true') return false;
  const ca = process.env.DB_SSL_CA?.trim() || undefined;
  const rejectUnauthorized = process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false';
  if (!rejectUnauthorized && process.env.NODE_ENV === 'production') {
    throw new Error('DB_SSL_REJECT_UNAUTHORIZED=false is forbidden when NODE_ENV=production');
  }
  return { rejectUnauthorized, ...(ca ? { ca } : {}) };
}

// In‑memory store used when MOCK_MODE=true (no real DB needed)
export const mockStore: {
  machines: any[];
  findings: any[];
  scans: any[];
  controls: any[];
  checklists: any[];
  auditLogs: any[];
  poams: any[];
  poamMilestones: any[];
  complianceHistory: any[];
  remediationJobs: any[];
  notificationConfigs: any[];
  vulnerabilities: any[];
} = {
  machines: [],
  findings: [],
  scans: [],
  controls: [],
  checklists: [],
  auditLogs: [],
  poams: [],
  poamMilestones: [],
  complianceHistory: [],
  remediationJobs: [],
  notificationConfigs: [],
  vulnerabilities: [],
};

export async function initializeDatabase(): Promise<void> {
  if (isMockMode) {
    await seedMockData();
    return;
  }
  await AppDataSource.initialize();
  // Apply any pending migrations on startup so deployments don't require a
  // manual `npm run migration:run` step. Safe to call repeatedly — TypeORM
  // tracks applied migrations in the `migrations` table.
  if (process.env.SKIP_AUTO_MIGRATIONS !== 'true') {
    const pending = await AppDataSource.runMigrations({ transaction: 'each' });
    if (pending.length) {
      // eslint-disable-next-line no-console
      console.log(`[db] applied ${pending.length} migration(s):`,
        pending.map((m) => m.name).join(', '));
    }
  }
}

async function seedMockData(): Promise<void> {
  const { seedMock } = await import('./mockSeed');
  seedMock(mockStore);
}
