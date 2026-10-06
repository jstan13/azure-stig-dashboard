/**
 * Deployment-wide settings for the DISA GPO release lifecycle.
 *
 *   discoveryMode   manual    — only "Check DISA now" looks for packages
 *                   scheduled — the tracker also checks on the schedule below
 *   carryForwardMode auto     — customizations found in production GPOs become
 *                               approved exceptions and ride along to test/prod
 *                    review   — they become pending exceptions a human approves
 */
import {
  Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

export type GpoDiscoveryMode = 'manual' | 'scheduled';
export type GpoDiscoveryFrequency = 'daily' | 'weekly';
export type GpoCarryForwardMode = 'auto' | 'review';

@Entity('gpo_settings')
export class GpoSettingsEntity {
  @PrimaryColumn({ type: 'varchar', default: 'singleton' }) id!: string;
  @Column({ type: 'varchar', default: 'manual' }) discoveryMode!: GpoDiscoveryMode;
  @Column({ type: 'varchar', default: 'weekly' }) frequency!: GpoDiscoveryFrequency;
  @Column({ type: 'int', default: 1 }) dayOfWeek!: number;
  @Column({ type: 'int', default: 6 }) hour!: number;
  @Column({ type: 'int', default: 30 }) minute!: number;
  @Column({ type: 'varchar', default: 'UTC' }) timeZone!: string;
  @Column({ type: 'varchar', default: 'auto' }) carryForwardMode!: GpoCarryForwardMode;
  @Column({ type: 'int', default: 24 }) testSoakHours!: number;
  @Column({ default: false }) requireDistinctApprovers!: boolean;
  @Column({ type: 'timestamptz', nullable: true }) lastCheckedAt!: Date | null;
  @Column({ type: 'varchar', nullable: true }) lastCheckOutcome!: string | null;
  @Column({ type: 'text', nullable: true }) lastCheckError!: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
}
