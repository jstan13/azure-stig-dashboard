import {
  Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

/**
 * Business-hours power schedule for the dashboard's own Azure resources.
 *
 * The scheduler Function starts and stops the web apps and the PostgreSQL
 * server around these hours to keep idle cost down. The rules live here rather
 * than in Function app settings so an admin can change them after install
 * without a redeployment.
 *
 * `deferUntil` backs the "working late" button: while it is in the future the
 * evening shutdown is suppressed, and it expires on its own so a forgotten
 * deferral cannot silently disable the schedule forever.
 */
@Entity('power_schedule')
export class PowerScheduleEntity {
  @PrimaryColumn({ type: 'varchar', default: 'singleton' }) id!: string;

  /** Master switch. When false the scheduler leaves the resources alone. */
  @Column({ default: false }) enabled!: boolean;

  /** When false the resources are started but never stopped. */
  @Column({ default: false }) autoShutdown!: boolean;

  /** IANA zone the hours below are expressed in (handles DST correctly). */
  @Column({ type: 'varchar', default: 'UTC' }) timeZone!: string;

  @Column({ type: 'int', default: 8 }) startHour!: number;

  @Column({ type: 'int', default: 0 }) startMinute!: number;

  @Column({ type: 'int', default: 18 }) endHour!: number;

  @Column({ type: 'int', default: 0 }) endMinute!: number;

  /** Days the system should be up. 0 = Sunday … 6 = Saturday. */
  @Column({ type: 'jsonb', default: () => `'[1,2,3,4,5]'` }) days!: number[];

  /** Suppress shutdown until this instant. Null = no active deferral. */
  @Column({ type: 'timestamptz', nullable: true }) deferUntil!: Date | null;

  @Column({ type: 'varchar', nullable: true }) deferredBy!: string | null;

  @Column({ type: 'varchar', nullable: true }) lastAction!: 'started' | 'stopped' | null;

  @Column({ type: 'timestamptz', nullable: true }) lastActionAt!: Date | null;

  /**
   * Last time the scheduler Function checked in. Without this the UI would
   * happily show "next shutdown 6:00 PM" even when nothing is enforcing the
   * schedule at all, which is exactly how a broken scheduler went unnoticed
   * before. Null until the first poll after install.
   */
  @Column({ type: 'timestamptz', nullable: true }) lastPolledAt!: Date | null;

  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}
