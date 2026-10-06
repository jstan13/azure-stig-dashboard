/**
 * GPO release lifecycle.
 *
 * A GpoRelease is one DISA GPO package moving through:
 *
 *   awaiting_test_approval ─(human)─▶ test_deploying ─▶ test_validating
 *     ─(evidence passes)─▶ staging_production ─▶ awaiting_production_approval
 *     ─(human)─▶ releasing ─▶ released ─(human)─▶ rolling_back ─▶ rolled_back
 *
 * Every arrow that touches a domain is a GpoJob executed by an on-premises
 * agent for exactly one environment. The tracker never holds AD credentials.
 */
import {
  Entity, PrimaryGeneratedColumn, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn,
  Index, ManyToOne, JoinColumn,
} from 'typeorm';
import type { GpoPackageDiff, PackageGpo, GpoSettings } from '../gpo/gpoPackage';

export type GpoEnvironment = 'test' | 'production';

export type GpoReleaseStatus =
  | 'awaiting_test_approval'
  | 'test_deploying'
  | 'test_validating'
  | 'staging_production'
  | 'awaiting_production_approval'
  | 'releasing'
  | 'released'
  | 'rolling_back'
  | 'rolled_back'
  | 'failed'
  | 'rejected'
  | 'superseded';

export type GpoFailedStage =
  | 'test_deploy'
  | 'test_validation'
  | 'production_stage'
  | 'production_release'
  | 'rollback';

export type GpoJobType = 'survey' | 'deploy' | 'validate' | 'stage' | 'release' | 'rollback';
export type GpoJobStatus = 'queued' | 'claimed' | 'succeeded' | 'failed' | 'cancelled';

export interface DeployedGpo {
  id: string;
  name: string;
  sourceBackupId: string;
  family: string;
}

export interface GpoLinkRecord {
  target: string;
  gpoId: string;
  gpoName: string;
  order?: number | null;
  enabled?: boolean;
  enforced?: boolean;
}

export interface GpoDeviation {
  gpoId: string;
  gpoName: string;
  sourceBackupId: string;
  added: string[];
  removed: string[];
  changed: string[];
}

export interface ValidationComputer {
  name: string;
  reachable: boolean;
  error?: string | null;
  distinguishedName?: string | null;
  expectedGpoIds: string[];
  appliedGpoIds: string[];
  filteredGpoIds: string[];
  missingGpoIds: string[];
  extensionErrors: Array<{ name: string; code: string }>;
  script?: { passed: boolean; summary?: string | null } | null;
}

export interface ValidationEvidence {
  computers: ValidationComputer[];
  collectedAt: string;
}

export interface ValidationOutcome {
  passed: boolean;
  reasons: string[];
  evaluatedAt: string;
}

export interface EnvironmentState {
  agent?: string;
  gpos: DeployedGpo[];
  links: GpoLinkRecord[];
  previousLinks: GpoLinkRecord[];
  deviations: GpoDeviation[];
  validation?: ValidationEvidence | null;
  outcome?: ValidationOutcome | null;
  /** Production customizations found at staging time that this release does not include. */
  uncovered?: GpoCustomization[];
  /** Customizations frozen into this release that production no longer has. */
  stale?: GpoExceptionSnapshot[];
  /** Production customizations deliberately not carried forward (exception revoked or expired). */
  dropped?: GpoCustomization[];
  /** Production differences the agent cannot carry forward automatically. */
  unsupported?: GpoUnsupportedChange[];
  updatedAt: string;
}

/** A setting a production GPO has that differs from the DISA backup it came from. */
export interface GpoCustomization {
  gpoFamily: string;
  kind: 'registry' | 'securityTemplate';
  action: 'set' | 'delete';
  hive?: string | null;
  key?: string | null;
  valueName?: string | null;
  valueType?: string | null;
  value?: string | null;
  section?: string | null;
  settingKey?: string | null;
  settingValue?: string | null;
  sourceGpoName: string;
  baselineKnown: boolean;
}

export interface GpoUnsupportedChange {
  gpoFamily: string;
  gpoName: string;
  detail: string;
}

export interface ProductionSurvey {
  surveyedAt: string;
  agent?: string;
  gpos: Array<{
    gpoFamily: string;
    gpoId: string;
    gpoName: string;
    baseline: 'release' | 'package' | 'unknown';
    baselineLabel?: string | null;
  }>;
  customizations: GpoCustomization[];
  unsupported: GpoUnsupportedChange[];
}

export interface GpoDecision {
  action: string;
  actor: string;
  actorOid: string | null;
  at: string;
  comment?: string | null;
}

/** Exception overlay frozen onto a release when testing is approved. */
export interface GpoExceptionSnapshot {
  id: string;
  gpoFamily: string;
  kind: 'registry' | 'securityTemplate';
  action: 'set' | 'delete';
  hive: string | null;
  key: string | null;
  valueName: string | null;
  valueType: string | null;
  value: string | null;
  section: string | null;
  settingKey: string | null;
  settingValue: string | null;
  justification: string;
  approvedBy: string | null;
  source?: 'manual' | 'detected';
}

@Entity('gpo_releases')
@Index('idx_gpo_release_status', ['status'])
export class GpoReleaseEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() packageName!: string;
  /** DISA's quarter label, e.g. "July 2026". */
  @Column() label!: string;
  @Column({ type: 'timestamptz', nullable: true }) releaseDate!: Date | null;
  @Column({ type: 'text' }) downloadUrl!: string;
  @Column() filename!: string;
  /** SHA-256 of the exact archive every environment must deploy. */
  @Column({ type: 'varchar', length: 64, unique: true }) sourceHash!: string;
  @Column({ type: 'int', default: 0 }) sizeBytes!: number;
  @Column({ type: 'varchar', default: 'awaiting_test_approval' }) status!: GpoReleaseStatus;
  @Column({ type: 'varchar', nullable: true }) failedStage!: GpoFailedStage | null;
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" }) gpos!: PackageGpo[];
  /** Flattened DISA settings per backup; large, so excluded from default selects. */
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb", select: false })
    settingsSnapshot!: Record<string, GpoSettings>;
  @Column({ type: 'jsonb', nullable: true }) diff!: GpoPackageDiff | null;
  @Column({ type: 'jsonb', nullable: true }) exceptionsSnapshot!: GpoExceptionSnapshot[] | null;
  /** What the production agent found in the GPOs currently live in production. */
  @Column({ type: 'jsonb', nullable: true }) productionSurvey!: ProductionSurvey | null;
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
    environments!: Partial<Record<GpoEnvironment, EnvironmentState>>;
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" }) decisions!: GpoDecision[];
  @Column({ type: 'timestamptz', nullable: true }) releasedAt!: Date | null;
  @Column({ type: 'text', nullable: true }) lastError!: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) discoveredAt!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
}

@Entity('gpo_jobs')
@Index('idx_gpo_job_queue', ['environment', 'status', 'notBefore'])
export class GpoJobEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;

  @ManyToOne(() => GpoReleaseEntity, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'releaseId', foreignKeyConstraintName: 'FK_gpo_jobs_release' })
  release!: GpoReleaseEntity;

  @Column() releaseId!: string;
  @Column({ type: 'varchar' }) environment!: GpoEnvironment;
  @Column({ type: 'varchar' }) type!: GpoJobType;
  @Column({ type: 'varchar', default: 'queued' }) status!: GpoJobStatus;
  @Column({ type: 'timestamptz', default: () => 'now()' }) notBefore!: Date;
  @Column({ type: 'int', default: 0 }) attempts!: number;
  @Column({ type: 'int', default: 3 }) maxAttempts!: number;
  @Column({ type: 'varchar', nullable: true }) claimedByOid!: string | null;
  @Column({ type: 'varchar', nullable: true }) claimedBy!: string | null;
  @Column({ type: 'timestamptz', nullable: true }) claimedAt!: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) leaseExpiresAt!: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) completedAt!: Date | null;
  /** Agent-uploaded GPO reports compared against the DISA baseline. */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" }) deviations!: GpoDeviation[];
  @Column({ type: 'jsonb', nullable: true }) result!: Record<string, unknown> | null;
  @Column({ type: 'text', nullable: true }) error!: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
}

/** Last check-in per environment so reviewers can see whether an agent is alive. */
@Entity('gpo_agents')
export class GpoAgentEntity {
  @PrimaryColumn({ type: 'varchar' }) environment!: GpoEnvironment;
  @Column({ type: 'varchar' }) agentOid!: string;
  @Column({ type: 'varchar', nullable: true }) hostname!: string | null;
  @Column({ type: 'varchar', nullable: true }) version!: string | null;
  @Column({ type: 'timestamptz' }) lastSeenAt!: Date;
}
