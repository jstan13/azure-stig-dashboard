/**
 * PowerStigResult — raw output from a single PowerSTIG DSC audit run on a machine.
 *
 * PowerSTIG generates a DSC configuration from an XCCDF benchmark and executes it
 * via Azure VM Run Command (Compute VMs) or Azure Arc Run Extension (Arc machines).
 * The resulting MOF test output is parsed into individual check results and stored here,
 * then rolled up into Finding records for the dashboard.
 *
 * Retaining raw results allows re-processing when mapping rules change.
 */
import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { MachineEntity } from './Machine';
import { StigVersionEntity } from './StigVersion';

export type DscResult = 'Pass' | 'Fail' | 'Error' | 'NotApplicable' | 'Skipped';

@Entity('powerstig_results')
@Index(['machineId', 'stigVersionId', 'ruleId'])
export class PowerStigResultEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;

  @ManyToOne(() => MachineEntity, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'machineId' })
  machine!: MachineEntity;

  @Column() machineId!: string;

  @ManyToOne(() => StigVersionEntity, { nullable: false })
  @JoinColumn({ name: 'stigVersionId' })
  stigVersion!: StigVersionEntity;

  @Column() stigVersionId!: string;

  /** STIG rule ID, e.g. "V-220700" */
  @Column() ruleId!: string;

  /** DSC resource name that performed the check */
  @Column({ nullable: true }) dscResource!: string;

  /** The specific check type: Registry, AuditPolicy, UserRightsAssignment, Service, etc. */
  @Column({ nullable: true }) checkType!: string;

  /** Full DSC check output result */
  @Column({ type: 'varchar' }) result!: DscResult;

  /** Human-readable reason / difference reported by DSC */
  @Column({ type: 'text', nullable: true }) reason!: string;

  /**
   * Raw DSC InDesiredState properties as JSON, e.g.:
   * { "Key": "HKLM:\\SYSTEM\\...", "ValueName": "MaxSize", "ValueData": "65536", "actual": "16384" }
   */
  @Column({ type: 'jsonb', nullable: true }) rawProperties!: Record<string, any>;

  /** Job ID of the Azure VM RunCommand or Arc RunExtension that produced this result */
  @Column({ nullable: true }) runCommandJobId!: string;

  @CreateDateColumn() checkedAt!: Date;
}
