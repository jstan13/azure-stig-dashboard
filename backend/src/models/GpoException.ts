/**
 * A documented, approved deviation from a DISA GPO, applied to every future
 * release of the same GPO family so exceptions carry forward each quarter.
 *
 *   registry          — Set-GPRegistryValue / Remove-GPRegistryValue after import
 *   securityTemplate  — edits GptTmpl.inf in the backup before Import-GPO
 */
import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index,
} from 'typeorm';

export type GpoExceptionKind = 'registry' | 'securityTemplate';
export type GpoExceptionStatus = 'pending' | 'approved' | 'revoked';
/** manual = authored by a person; detected = found in a production GPO by the survey. */
export type GpoExceptionSource = 'manual' | 'detected';

@Entity('gpo_exceptions')
@Index('idx_gpo_exception_family', ['gpoFamily'])
export class GpoExceptionEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  /** Version-independent DISA GPO name, e.g. "DoD WinSvr 2022 MS STIG Comp". */
  @Column() gpoFamily!: string;
  @Column({ type: 'varchar' }) kind!: GpoExceptionKind;
  @Column({ type: 'varchar', default: 'set' }) action!: 'set' | 'delete';
  @Column({ type: 'varchar', nullable: true }) hive!: string | null;
  @Column({ type: 'text', nullable: true }) key!: string | null;
  @Column({ type: 'text', nullable: true }) valueName!: string | null;
  @Column({ type: 'varchar', nullable: true }) valueType!: string | null;
  @Column({ type: 'text', nullable: true }) value!: string | null;
  @Column({ type: 'varchar', nullable: true }) section!: string | null;
  @Column({ type: 'varchar', nullable: true }) settingKey!: string | null;
  @Column({ type: 'text', nullable: true }) settingValue!: string | null;
  @Column({ type: 'text' }) justification!: string;
  /** POA&M, waiver, or ticket reference. */
  @Column({ type: 'varchar', nullable: true }) reference!: string | null;
  @Column({ type: 'varchar', default: 'pending' }) status!: GpoExceptionStatus;
  @Column({ type: 'varchar', default: 'manual' }) source!: GpoExceptionSource;
  /** Production GPO the customization was found in (detected exceptions). */
  @Column({ type: 'varchar', nullable: true }) detectedFrom!: string | null;
  /**
   * False when the survey could not find the DISA release the production GPO
   * came from, so the difference may be a DISA change rather than a local one.
   * Such exceptions always need human approval.
   */
  @Column({ default: true }) baselineKnown!: boolean;
  @Column({ type: 'varchar' }) requestedByOid!: string;
  @Column({ type: 'varchar' }) requestedBy!: string;
  @Column({ type: 'varchar', nullable: true }) approvedByOid!: string | null;
  @Column({ type: 'varchar', nullable: true }) approvedBy!: string | null;
  @Column({ type: 'timestamptz', nullable: true }) approvedAt!: Date | null;
  @Column({ type: 'varchar', nullable: true }) revokedBy!: string | null;
  @Column({ type: 'timestamptz', nullable: true }) revokedAt!: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) expiresAt!: Date | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
}
