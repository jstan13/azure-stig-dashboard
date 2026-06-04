import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index,
} from 'typeorm';
import { ROLES, type Role } from '../auth/permissions';

/**
 * RoleBinding — grants a role to a principal (user), optionally scoped to a
 * Collection.
 *
 *   - collectionId = null  -> GLOBAL grant (applies across every boundary).
 *   - collectionId = <id>  -> grant applies only within that Collection.
 *
 * A binding is active while `revokedAt` is null. Revocation is soft (audit
 * trail), so the active-uniqueness invariant (one live row per
 * subjectOid+collectionId+role) is enforced in application code rather than a
 * DB constraint, since SQL UNIQUE treats NULLs as distinct.
 */
@Entity('role_bindings')
@Index('idx_role_binding_subject', ['subjectOid'])
@Index('idx_role_binding_collection', ['collectionId'])
export class RoleBindingEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;

  /** Entra object id (oid) of the user the role is granted to. */
  @Column() subjectOid!: string;

  /** Null = global; otherwise the Collection this grant is scoped to. */
  @Column({ nullable: true }) collectionId!: string | null;

  @Column({ type: 'enum', enum: ROLES }) role!: Role;

  /** Object id (oid) of the principal that granted the role. */
  @Column({ nullable: true }) grantedBy!: string | null;

  @CreateDateColumn() grantedAt!: Date;

  /** Set when the binding is revoked; null while active. */
  @Column({ type: 'timestamptz', nullable: true }) revokedAt!: Date | null;
}
