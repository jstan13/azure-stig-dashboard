/**
 * Permission-based authorization decision (the successor to the role-rank
 * `authorize()` in rbac.ts).
 *
 * A decision combines a principal's resolved roles (see roleResolver.ts) with
 * the permission catalog (permissions.ts):
 *
 *   - GLOBAL permissions (e.g. users:manage) are satisfied only by a global
 *     role grant; Collection scope is irrelevant.
 *   - SCOPABLE permissions (e.g. findings:write) are satisfied by EITHER a
 *     global grant (covers every boundary) OR a grant within one of the
 *     candidate Collections the request targets.
 *
 * When the request's scope cannot be pinned to specific Collections, an
 * "any scope" check is used: the principal is allowed if it holds the
 * permission globally or within ANY Collection. The route still fails closed
 * for principals that do not hold the permission anywhere.
 */
import {
  isGlobalPermission,
  permissionsForRoles,
  type Permission,
  type Role,
} from './permissions';
import type { ResolvedRoles } from './roleResolver';

/** True if the principal's global roles grant the permission. */
export function permittedGlobally(
  resolved: ResolvedRoles,
  permission: Permission,
): boolean {
  return permissionsForRoles(resolved.global).has(permission);
}

/** True if any of the candidate Collections grants the permission. */
export function permittedInCollections(
  resolved: ResolvedRoles,
  permission: Permission,
  collectionIds: readonly string[],
): boolean {
  for (const id of collectionIds) {
    const roles = resolved.byCollection.get(id);
    if (roles && permissionsForRoles(roles).has(permission)) return true;
  }
  return false;
}

/** True if the permission is granted globally or within ANY Collection. */
export function permittedAnyScope(
  resolved: ResolvedRoles,
  permission: Permission,
): boolean {
  if (permittedGlobally(resolved, permission)) return true;
  for (const roles of resolved.byCollection.values()) {
    if (permissionsForRoles(roles).has(permission)) return true;
  }
  return false;
}

export interface CanArgs {
  resolved: ResolvedRoles;
  permission: Permission;
  /**
   * Candidate Collections the request targets. `undefined` means the scope is
   * unknown -> fall back to an any-scope check for scopable permissions.
   */
  collectionIds?: readonly string[] | undefined;
}

/** Central allow/deny decision for a single permission check. */
export function can(args: CanArgs): boolean {
  const { resolved, permission, collectionIds } = args;

  if (isGlobalPermission(permission)) {
    return permittedGlobally(resolved, permission);
  }

  // Scopable permission.
  if (permittedGlobally(resolved, permission)) return true;
  if (collectionIds === undefined) {
    return permittedAnyScope(resolved, permission);
  }
  return permittedInCollections(resolved, permission, collectionIds);
}

/** Convenience: highest-ranked global role label for audit rows. */
export function primaryGlobalRole(resolved: ResolvedRoles): Role | 'none' {
  const order: Role[] = ['admin', 'issm', 'isso', 'operator', 'auditor'];
  for (const r of order) {
    if (resolved.global.has(r)) return r;
  }
  return 'none';
}
