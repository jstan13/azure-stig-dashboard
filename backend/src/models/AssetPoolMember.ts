import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index, Unique,
} from 'typeorm';

/**
 * AssetPoolMember — explicit membership of a Machine in an AssetPool.
 *
 * Used for selectionMode='explicit' pools, and as an additive override for
 * 'tag' pools. A machine may belong to multiple pools.
 */
@Entity('asset_pool_members')
@Unique('uq_asset_pool_member', ['poolId', 'machineId'])
@Index('idx_asset_pool_member_machine', ['machineId'])
export class AssetPoolMemberEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;

  @Column() poolId!: string;

  @Column() machineId!: string;

  /** Object id (oid) of the principal that added the machine. */
  @Column({ type: 'varchar', nullable: true }) addedBy!: string | null;

  @CreateDateColumn() addedAt!: Date;
}
