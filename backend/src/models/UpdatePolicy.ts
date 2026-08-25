/**
 * UpdatePolicy — singleton row holding the deployment's auto-update settings
 * and the state machine the scheduler drives.
 *
 * Modes:
 *   off     — never check, never notify
 *   notify  — check for releases and surface a banner; a human applies them
 *   auto    — apply inside the configured window, optionally gated on approval
 *
 * `requireApproval` is what separates "set and forget" from "approve each one".
 * With it on, `auto` still waits for an admin to approve the specific version
 * before the scheduler will touch anything.
 */

import {
  Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

export type UpdateMode = 'off' | 'notify' | 'auto';

/** Outcome of a single attempted update, newest first in `history`. */
export interface UpdateHistoryEntry {
  version: string;
  previousVersion: string | null;
  startedAt: string;
  finishedAt: string | null;
  result: 'succeeded' | 'rolled_back' | 'failed';
  detail?: string;
  /** Who approved it, or 'scheduler' when running unattended. */
  actor?: string;
}

@Entity('update_policy')
export class UpdatePolicyEntity {
  /** Always 'singleton' — one policy per deployment. */
  @PrimaryColumn({ type: 'varchar', default: 'singleton' }) id!: string;

  @Column({ type: 'varchar', default: 'notify' }) mode!: UpdateMode;

  /** True = an admin must approve each version. False = set and forget. */
  @Column({ default: true }) requireApproval!: boolean;

  /** Skip releases not flagged as security fixes. */
  @Column({ default: false }) securityOnly!: boolean;

  /** 0=Sunday … 6=Saturday. Null = any day. */
  @Column({ type: 'int', nullable: true }) dayOfWeek!: number | null;

  /** Hour the window opens, in `timeZone`. The window is one hour long. */
  @Column({ type: 'int', default: 2 }) hour!: number;

  @Column({ type: 'varchar', default: 'UTC' }) timeZone!: string;

  /** Release tag currently deployed, e.g. 'v0.3.4'. */
  @Column({ type: 'varchar', nullable: true }) currentVersion!: string | null;

  /** Newest release seen upstream. */
  @Column({ type: 'varchar', nullable: true }) availableVersion!: string | null;

  /** Release notes for `availableVersion`, shown in the approval prompt. */
  @Column({ type: 'text', nullable: true }) availableNotes!: string | null;

  /** Version an admin has explicitly cleared for install. */
  @Column({ type: 'varchar', nullable: true }) approvedVersion!: string | null;

  @Column({ type: 'varchar', nullable: true }) approvedBy!: string | null;

  @Column({ type: 'timestamptz', nullable: true }) lastCheckedAt!: Date | null;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
    history!: UpdateHistoryEntry[];

  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}
