import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn,
} from 'typeorm';
import { MachineEntity } from './Machine';
import { ControlEntity } from './Control';

/**
 * A Finding represents the evaluation result for one Control on one Machine.
 * Status values match STIG Viewer conventions.
 */
@Entity('findings')
export class FindingEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() machineId!: string;
  @Column() controlId!: string;
  /** open | not_a_finding | not_applicable | not_reviewed */
  @Column({ default: 'not_reviewed' }) status!: string;
  @Column({ default: 'medium' }) severity!: string;
  /** STIG Viewer "Comments" field */
  @Column({ type: 'text', nullable: true }) comments!: string;
  /** STIG Viewer "Finding Details" field */
  @Column({ type: 'text', nullable: true }) findingDetails!: string;
  /** Source of the finding: azure-policy | defender | resource-graph | manual */
  @Column({ default: 'azure-policy' }) sourceType!: string;
  /**
   * Provenance of a *manual* answer, when the current status was set by a human
   * (directly or through inheritance). One of:
   *   'machine'  — answered on this specific finding (machine-scoped).
   *   'pool'     — inherited from an AssetPool ManualAnswer.
   *   'platform' — inherited from a platform-wide ManualAnswer.
   *   null       — automated/default status (never manually answered).
   * Precedence: machine > pool > platform. A higher scope must never overwrite
   * a lower (more specific) one.
   */
  @Column({ type: 'varchar', nullable: true }) manualAnswerScope!: 'machine' | 'pool' | 'platform' | null;
  /** AssetPool id or platform key the inherited answer came from (null for machine/auto). */
  @Column({ type: 'varchar', nullable: true }) manualAnswerScopeId!: string | null;
  /** Raw evidence payload from Azure (policy evaluation result, Defender alert, etc.) */
  @Column({ type: 'jsonb', nullable: true }) evidence!: Record<string, any>;
  /**
   * Full traceability chain (constitution Principle IV, FR-009): every
   * Finding must record how its source signal was mapped onto a STIG rule.
   * Persisted as JSONB so the schema can evolve without per-source migrations.
   *
   * Shape:
   *   {
   *     source: 'azure-policy' | 'defender' | 'resource-graph' | 'manual' | 'stig-manager',
   *     sourceRef: string,            // policy assignment id / alert id / query hash
   *     vulnNum: string,              // e.g. "V-220706"
   *     ruleId: string,               // e.g. "SV-220706r569186_rule"
   *     cciRefs: string[],            // e.g. ["CCI-000196"]
   *     nistControls: string[],       // e.g. ["IA-5 (1) (c)"]
   *     stigBenchmarkId: string,      // e.g. "Microsoft_Windows_Server_2022_STIG"
   *     stigBenchmarkVersion: string, // e.g. "V1R3"
   *     benchmarkSha256: string,      // sha256 of source XCCDF (Principle III)
   *     mappedAt: string,             // ISO-8601 UTC
   *     mappedBy: string,             // mapping engine version, e.g. "mc-windows-2022@1.4.0"
   *   }
   *
   * `null` means the Finding predates the traceability requirement; new
   * Findings emitted by the ingestion pipeline MUST populate this.
   */
  @Column({ type: 'jsonb', nullable: true }) mappingChain!: {
    source: string;
    sourceRef: string;
    vulnNum: string;
    ruleId: string;
    cciRefs: string[];
    nistControls: string[];
    stigBenchmarkId: string;
    stigBenchmarkVersion: string;
    benchmarkSha256: string;
    mappedAt: string;
    mappedBy: string;
  } | null;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
  @Column({ type: 'timestamp', nullable: true }) reviewedAt!: Date | null;
  @ManyToOne(() => MachineEntity, (m) => m.findings)
  @JoinColumn({ name: 'machineId' })
  machine!: MachineEntity;
  @ManyToOne(() => ControlEntity)
  @JoinColumn({ name: 'controlId' })
  control!: ControlEntity;
}
