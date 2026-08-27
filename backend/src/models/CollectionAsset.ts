import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index, Unique,
} from 'typeorm';

/**
 * CollectionAsset — explicit membership of a Machine in a Collection.
 *
 * Used for selectionMode='explicit' collections, and as an override/addition
 * for 'tag' collections. A machine may belong to multiple collections.
 */
@Entity('collection_assets')
@Unique('uq_collection_asset', ['collectionId', 'machineId'])
@Index('idx_collection_asset_machine', ['machineId'])
export class CollectionAssetEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;

  @Column() collectionId!: string;

  @Column() machineId!: string;

  /** Object id (oid) of the principal that added the asset. */
  @Column({ type: 'varchar', nullable: true }) addedBy!: string | null;

  @CreateDateColumn() addedAt!: Date;
}
