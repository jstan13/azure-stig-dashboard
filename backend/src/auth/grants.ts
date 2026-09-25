/**
 * Limits on who may grant or revoke a role binding / group mapping.
 *
 * `roles:assign` is a scopable permission, so the route guard alone lets an
 * ISSM who holds it in a single Collection reach the assignment endpoints.
 * Without these limits that ISSM could mint a global admin. A grantor may only
 * hand out (or take away) a role:
 *   - in a scope where they hold `roles:assign` (a global grant needs a global
 *     `roles:assign`; a Collection grant needs it globally or in that Collection);
 *   - no higher than the highest role they hold in that scope.
 */
import { permissionsForRoles, ROLE_RANK, type Role } from './permissions';
import type { ResolvedRoles } from './roleResolver';

/** Returns why the grant is not allowed, or null when it is. */
export function grantDenial(
  resolved: ResolvedRoles,
  role: Role,
  collectionId: string | null,
): string | null {
  const inScope = new Set<Role>(resolved.global);
  if (collectionId) {
    for (const r of resolved.byCollection.get(collectionId) ?? []) inScope.add(r);
  }
  if (!permissionsForRoles(inScope).has('roles:assign')) {
    return collectionId
      ? 'You cannot assign roles in this collection'
      : 'Only a global role holder can assign global roles';
  }
  const highest = Math.max(0, ...[...inScope].map((r) => ROLE_RANK[r]));
  if (ROLE_RANK[role] > highest) {
    return `You cannot assign or revoke the ${role} role, which is above your own`;
  }
  return null;
}
