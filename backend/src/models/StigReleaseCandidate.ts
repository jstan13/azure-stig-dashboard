import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
  Index, Unique, ManyToOne, JoinColumn,
} from 'typeorm';
import { StigBenchmarkEntity } from './StigBenchmark';

export type StigReleaseStatus =
  | 'ready'
  | 'approved'
  | 'importing'
  | 'applied'
  | 'failed'
  | 'dismissed';

export interface StigReleaseDiff {
  added: string[];
  removed: string[];
  changed: string[];
  severityChanged: string[];
}

@Entity('stig_release_candidates')
@Unique('uq_stig_release_benchmark_version', ['benchmarkId', 'version'])
@Index('idx_stig_release_status', ['status'])
export class StigReleaseCandidateEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;

  @ManyToOne(() => StigBenchmarkEntity, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'benchmarkId' })
  benchmark!: StigBenchmarkEntity;

  @Column() benchmarkId!: string;
  @Column() title!: string;
  @Column() version!: string;
  @Column({ type: 'timestamptz', nullable: true }) releaseDate!: Date | null;
  @Column({ type: 'text' }) downloadUrl!: string;
  @Column() filename!: string;
  @Column({ length: 64 }) sourceHash!: string;
  @Column({ type: 'varchar', default: 'ready' }) status!: StigReleaseStatus;
  @Column({ default: 0 }) addedRules!: number;
  @Column({ default: 0 }) removedRules!: number;
  @Column({ default: 0 }) changedRules!: number;
  @Column({ default: 0 }) severityChanges!: number;
  @Column({ type: 'jsonb', default: () => "'{\"added\":[],\"removed\":[],\"changed\":[],\"severityChanged\":[]}'::jsonb" })
    diff!: StigReleaseDiff;
  @Column({ type: 'varchar', nullable: true }) approvedBy!: string | null;
  @Column({ type: 'timestamptz', nullable: true }) approvedAt!: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) appliedAt!: Date | null;
  @Column({ type: 'text', nullable: true }) errorMessage!: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) discoveredAt!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
}
