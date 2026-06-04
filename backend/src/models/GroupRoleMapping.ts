import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index, Unique,
} from 'typeorm';
import { ROLES, type Role } from '../auth/permissions';

/**
 * GroupRoleMapping — maps an Entra security group to a role, optionally scoped
 * to a Collection.
 *
 * This is the "use existing Entra groups" path: instead of assigning the app's
 * roles to each user, an admin maps a group's object id to a role. Any user
 * whose token carries that group (the `groups` claim) inherits the role.
 *
 *   - collectionId = null  -> GLOBAL mapping.
 *   - collectionId = <id>  -> scoped to that Collection.
 */
@Entity('group_role_mappings')
@Unique('uq_group_role_mapping', ['groupObjectId', 'collectionId', 'role'])
@Index('idx_group_role_mapping_group', ['groupObjectId'])
export class GroupRoleMappingEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;

  /** Entra security-group object id (matches a value in the token `groups` claim). */
  @Column() groupObjectId!: string;

  /** Optional human-friendly label for the group (display only). */
  @Column({ nullable: true }) groupDisplayName!: string | null;

  @Column({ type: 'enum', enum: ROLES }) role!: Role;

  /** Null = global; otherwise the Collection this mapping is scoped to. */
  @Column({ nullable: true }) collectionId!: string | null;

  /** Object id (oid) of the principal that created the mapping. */
  @Column({ nullable: true }) createdBy!: string | null;

  @CreateDateColumn() createdAt!: Date;
}
