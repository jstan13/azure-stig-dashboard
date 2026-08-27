import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index, Unique,
} from 'typeorm';

/**
 * ManualAnswer — the authoritative record of a manual STIG answer that applies
 * to more than one machine, authored **once** at a broader scope.
 *
 * Scope:
 *   - 'pool'     — applies to every machine in AssetPool `scopeId`.
 *   - 'platform' — applies to every machine whose derived platform === `scopeId`
 *                  (e.g. 'azure', 'arc'). See `utils/platform.ts`.
 *
 * Machine-specific answers are NOT stored here — they live directly on the
 * Finding row (Finding.status / comments / findingDetails with
 * Finding.manualAnswerScope = 'machine'). This table is the source of truth for
 * the broader scopes so that:
 *   1. a newly-discovered machine automatically inherits applicable answers
 *      (re-applied during scan), and
 *   2. editing one answer re-propagates to all members.
 *
 * Precedence when resolving a Finding's effective answer (highest wins):
 *      machine  >  pool  >  platform  >  automated/default
 */
@Entity('manual_answers')
@Unique('uq_manual_answer_scope_control', ['scopeType', 'scopeId', 'controlId'])
@Index('idx_manual_answer_control', ['controlId'])
@Index('idx_manual_answer_scope', ['scopeType', 'scopeId'])
export class ManualAnswerEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;

  /** 'pool' | 'platform' */
  @Column() scopeType!: 'pool' | 'platform';

  /** AssetPool id (scopeType='pool') or platform key (scopeType='platform'). */
  @Column() scopeId!: string;

  /** Control entity id the answer applies to. */
  @Column() controlId!: string;

  /** STIG vuln id captured for display/audit resilience (e.g. "V-220706"). */
  @Column({ type: 'varchar', nullable: true }) vulnId!: string | null;

  /** open | not_a_finding | not_applicable | not_reviewed */
  @Column({ default: 'not_reviewed' }) status!: string;

  @Column({ type: 'text', nullable: true }) comments!: string | null;

  @Column({ type: 'text', nullable: true }) findingDetails!: string | null;

  /** Object id (oid) of the principal that authored the answer. */
  @Column({ type: 'varchar', nullable: true }) answeredBy!: string | null;

  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}
