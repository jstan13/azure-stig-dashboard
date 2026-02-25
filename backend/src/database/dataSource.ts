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
  ],
  migrations: ['dist/database/migrations/*.js'],
  migrationsTableName: 'migrations',
  ssl: process.env.DB_SSL === 'true'
    ? { rejectUnauthorized: false }
    : false,
});

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
};

export async function initializeDatabase(): Promise<void> {
  if (isMockMode) {
    await seedMockData();
    return;
  }
  await AppDataSource.initialize();
}

async function seedMockData(): Promise<void> {
  const { seedMock } = await import('./mockSeed');
  seedMock(mockStore);
}
