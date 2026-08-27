import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index,
} from 'typeorm';

/**
 * Collection — an authorization boundary (an ATO / system boundary).
 *
 * RBAC role bindings are scoped to a Collection. A user granted `isso` on
 * Collection A has those permissions only over assets that belong to A.
 *
 * Membership can be defined two ways (selectionMode):
 *   - 'explicit' — assets are listed individually in CollectionAsset.
 *   - 'tag'      — assets are matched by an Azure tag rule (tagRule), e.g.
 *                  { "System": "FinanceATO" } matches machines whose tags
 *                  contain that key/value. Explicit assets are always included
 *                  in addition to tag matches.
 */
@Entity('collections')
@Index('idx_collection_tenant', ['tenantId'])
export class CollectionEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;

  @Column() name!: string;

  @Column({ type: 'text', nullable: true }) description!: string | null;

  /** Entra tenant this boundary belongs to (multi-tenant deployments). */
  @Column({ type: 'varchar', nullable: true }) tenantId!: string | null;

  /** How assets are associated with this collection. */
  @Column({ default: 'explicit' }) selectionMode!: 'tag' | 'explicit';

  /**
   * Tag-match rule for selectionMode='tag'. A machine belongs to the collection
   * when its `tags` contain every key/value pair in this object.
   */
  @Column({ type: 'jsonb', nullable: true }) tagRule!: Record<string, string> | null;

  @Column({ default: 'active' }) status!: 'active' | 'archived';

  /** Object id (oid) of the principal that created the collection. */
  @Column({ type: 'varchar', nullable: true }) createdBy!: string | null;

  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}
