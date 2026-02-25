/**
 * StigBenchmark — represents a top-level STIG product benchmark.
 * e.g. "Microsoft Windows 10 Security Technical Implementation Guide"
 *
 * One benchmark contains many versions (V1R1, V2R8, etc.).
 * Controls belong to a specific benchmark version.
 */
import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany,
} from 'typeorm';
import { StigVersionEntity } from './StigVersion';

@Entity('stig_benchmarks')
export class StigBenchmarkEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;

  /** XCCDF benchmark ID, e.g. "Windows_10_STIG" */
  @Column({ unique: true }) benchmarkId!: string;

  /** Human-readable title */
  @Column() title!: string;

  /** DISA product category: OS, Application, Network, etc. */
  @Column({ nullable: true }) category!: string;

  /** Operating system / platform tag, e.g. "Windows 10" */
  @Column({ nullable: true }) platform!: string;

  /** Latest installed version string, e.g. "V2R8" */
  @Column({ nullable: true }) latestInstalledVersion!: string;

  /** Latest available version on public.cyber.mil (populated by update check) */
  @Column({ nullable: true }) latestAvailableVersion!: string;

  /** URL of the STIG ZIP on public.cyber.mil */
  @Column({ nullable: true }) sourceUrl!: string;

  /** Date the installed content was last updated from DISA */
  @Column({ type: 'timestamptz', nullable: true }) lastContentUpdate!: Date;

  /** Whether this benchmark is actively monitored for quarterly updates */
  @Column({ default: true }) active!: boolean;

  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;

  @OneToMany(() => StigVersionEntity, (v) => v.benchmark)
  versions!: StigVersionEntity[];
}
