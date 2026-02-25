/**
 * StigVersion — a specific release of a benchmark, e.g. V2R8.
 * Each version corresponds to one XCCDF file ingested from DISA.
 * Controls reference a version, allowing the system to retain history
 * and detect which rules changed between releases.
 */
import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn,
} from 'typeorm';
import { StigBenchmarkEntity } from './StigBenchmark';

export type VersionStatus = 'pending' | 'downloading' | 'parsing' | 'active' | 'superseded' | 'error';

@Entity('stig_versions')
export class StigVersionEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;

  @ManyToOne(() => StigBenchmarkEntity, (b) => b.versions, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'benchmarkId' })
  benchmark!: StigBenchmarkEntity;

  @Column() benchmarkId!: string;

  /** e.g. "V2R8" */
  @Column() version!: string;

  /** XCCDF release string, e.g. "Release: 8 Benchmark Date: 26 Oct 2023" */
  @Column({ nullable: true }) releaseInfo!: string;

  /** XCCDF benchmark date */
  @Column({ nullable: true }) benchmarkDate!: string;

  /** DISA file name of the ZIP, for cache busting */
  @Column({ nullable: true }) sourceFilename!: string;

  /** SHA-256 hash of the downloaded ZIP, for integrity checks */
  @Column({ nullable: true }) sourceHash!: string;

  /** Total number of rules in this version */
  @Column({ default: 0 }) ruleCount!: number;

  /** CAT I rule count */
  @Column({ default: 0 }) catICount!: number;

  /** CAT II rule count */
  @Column({ default: 0 }) catIICount!: number;

  /** CAT III rule count */
  @Column({ default: 0 }) catIIICount!: number;

  @Column({ type: 'varchar', default: 'pending' })
  status!: VersionStatus;

  /** Error message if status=error */
  @Column({ type: 'text', nullable: true }) errorMessage!: string;

  @CreateDateColumn() importedAt!: Date;
}
