import {
  Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany, ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { ControlMappingEntity } from './ControlMapping';
import { StigVersionEntity } from './StigVersion';

@Entity('controls')
@Index(['stigVersionId', 'vulnId'])
export class ControlEntity {
  /** Composite: "<benchmarkId>|<vulnId>", e.g. "Windows_10_STIG|V-220700" */
  @PrimaryColumn() id!: string;

  // ── XCCDF identifiers ──────────────────────────────────────────────────
  /** Vuln_Num in XCCDF, e.g. "V-220700" */
  @Column() vulnId!: string;

  /** Rule_ID, e.g. "SV-220700r849121_rule" */
  @Column({ nullable: true }) ruleId!: string;

  /** Rule_Ver (STIG ID): e.g. "WN10-AU-000005" */
  @Column() stigId!: string;

  /** Group_Title (SRG reference): e.g. "SRG-OS-000001-GPOS-00001" */
  @Column({ nullable: true }) groupId!: string;

  /** Short rule title */
  @Column({ nullable: true }) title!: string;

  /** CAT I = high, CAT II = medium, CAT III = low */
  @Column({ default: 'medium' }) severity!: string;

  /** Detailed vulnerability discussion */
  @Column({ type: 'text', nullable: true }) description!: string;

  /** Check procedure text from XCCDF (includes registry paths, audit policy names, etc.) */
  @Column({ type: 'text', nullable: true }) checkContent!: string;

  /** Fix procedure text */
  @Column({ type: 'text', nullable: true }) fixText!: string;

  /**
   * Structured check descriptor parsed from checkContent.
   * Identifies what DSC resource type handles this rule:
   * Registry | AuditPolicy | UserRightsAssignment | Service | SecurityOption | AccountPolicy | FileContent | WinEventLog | DnsServerRootHint | etc.
   */
  @Column({ nullable: true }) checkType!: string;

  /**
   * Parsed check parameters as JSON — the machine-readable form of checkContent.
   * Example for a Registry check:
   * { "key": "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\EventLog\\Security", "valueName": "MaxSize", "valueType": "DWORD", "valueData": "32768", "operator": "GreaterThanOrEqual" }
   */
  @Column({ type: 'jsonb', nullable: true }) checkParameters!: Record<string, any>;

  /**
   * CCI (Control Correlation Identifier) list — links to NIST 800-53 controls.
   * Stored as JSON array of strings, e.g. ["CCI-000130", "CCI-000135"]
   */
  @Column({ type: 'jsonb', nullable: true }) ccis!: string[];

  /** STIG benchmark name: e.g. "Windows 10 STIG" */
  @Column({ nullable: true }) stigName!: string;

  // ── Azure mapping ────────────────────────────────────────────────────
  /** Azure Policy definition ID(s) that cover this control — JSON array */
  @Column({ type: 'jsonb', nullable: true }) azurePolicyIds!: string[];

  /** Defender for Cloud rule/recommendation IDs — JSON array */
  @Column({ type: 'jsonb', nullable: true }) defenderRuleIds!: string[];

  // ── Legacy single-value columns (kept for backward compat) ───────────
  @Column({ nullable: true }) azurePolicyId!: string;
  @Column({ nullable: true }) defenderRuleId!: string;

  // ── Version FK ───────────────────────────────────────────────────────
  @ManyToOne(() => StigVersionEntity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'stigVersionId' })
  stigVersion!: StigVersionEntity;

  @Column({ nullable: true }) stigVersionId!: string;

  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;

  @OneToMany(() => ControlMappingEntity, (m) => m.control)
  mappings!: ControlMappingEntity[];
}
