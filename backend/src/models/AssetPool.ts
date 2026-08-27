import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index,
} from 'typeorm';

/**
 * AssetPool — a named group of machines that share a *role* (e.g. "Domain
 * Controllers", "Web Servers", "DevOps Build Servers").
 *
 * Pools exist so a manual STIG answer can be authored **once** and inherited by
 * every member, rather than re-answered on each machine. Pools are NOT
 * authorization boundaries — that is the `Collection` entity. A machine may
 * belong to many pools.
 *
 * Membership mirrors the Collection pattern (selectionMode):
 *   - 'explicit' — machines listed individually in AssetPoolMember.
 *   - 'tag'      — machines matched by an Azure tag rule (tagRule). Explicit
 *                  members are always included in addition to tag matches.
 */
@Entity('asset_pools')
@Index('idx_asset_pool_tenant', ['tenantId'])
export class AssetPoolEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;

  @Column() name!: string;

  @Column({ type: 'text', nullable: true }) description!: string | null;

  /** Free-form role label shown in the UI, e.g. "Domain Controller". */
  @Column({ type: 'varchar', nullable: true }) role!: string | null;

  /** Entra tenant this pool belongs to (multi-tenant deployments). */
  @Column({ type: 'varchar', nullable: true }) tenantId!: string | null;

  /** How machines are associated with this pool. */
  @Column({ default: 'explicit' }) selectionMode!: 'tag' | 'explicit';

  /**
   * Tag-match rule for selectionMode='tag'. A machine belongs to the pool when
   * its `tags` contain every key/value pair in this object.
   */
  @Column({ type: 'jsonb', nullable: true }) tagRule!: Record<string, string> | null;

  @Column({ default: 'active' }) status!: 'active' | 'archived';

  /** Object id (oid) of the principal that created the pool. */
  @Column({ type: 'varchar', nullable: true }) createdBy!: string | null;

  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}
