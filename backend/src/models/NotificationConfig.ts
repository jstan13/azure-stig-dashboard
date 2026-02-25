/**
 * NotificationConfig — per-user or system-wide notification rules.
 *
 * Triggers: new_cat1 | overdue_poam | stig_update | daily_digest | weekly_digest
 * Channels:  email | teams_webhook | azure_monitor
 */

import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

export type NotificationTrigger =
  | 'new_cat1'
  | 'new_finding'
  | 'overdue_poam'
  | 'stig_update'
  | 'daily_digest'
  | 'weekly_digest'
  | 'scan_complete';

export type NotificationChannel = 'email' | 'teams_webhook' | 'azure_monitor';

@Entity('notification_configs')
export class NotificationConfigEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;

  /** Nullable = system-wide rule; set = user-specific */
  @Column({ nullable: true }) ownerOid!: string;

  @Column() trigger!: NotificationTrigger;
  @Column() channel!: NotificationChannel;

  /** Email address, Teams webhook URL, or Azure Monitor workspace ID */
  @Column({ type: 'text' }) destination!: string;

  /** Optional JSON filter — e.g. { "subscriptionIds": ["..."], "severity": "high" } */
  @Column({ type: 'jsonb', nullable: true }) filter!: Record<string, any>;

  @Column({ default: true }) enabled!: boolean;

  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}
