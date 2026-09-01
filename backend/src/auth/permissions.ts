/**
 * Permission catalog and role → permission mapping (RMF persona model).
 *
 * The dashboard authorizes on *permissions*, not raw roles. Roles are bundles
 * of permissions aligned to real RMF personas:
 *
 *   auditor  — Auditor / Assessor / Validator (read + report only)
 *   operator — System Administrator (auditor + operational actions, incl.
 *              editing manual STIG check status)
 *   isso     — Information System Security Officer (operator + POA&M /
 *              exception authoring)
 *   issm     — Information System Security Manager (isso + approvals; separated
 *              from execution to preserve two-person integrity / SoD)
 *   admin    — Application / platform owner (everything, plus global config)
 *
 * Some permissions are *global* (tenant-wide config that is never scoped to a
 * single ATO boundary); the rest are *scopable* and may be granted on a
 * specific Collection. See `GLOBAL_PERMISSIONS`.
 */

export const ROLES = ['auditor', 'operator', 'isso', 'issm', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/** Numeric rank for "at least this role" comparisons. Higher = more authority. */
export const ROLE_RANK: Record<Role, number> = {
  auditor: 1,
  operator: 2,
  isso: 3,
  issm: 4,
  admin: 5,
};

export const PERMISSIONS = [
  // Read / reporting
  'dashboard:read',
  'export:generate',
  'audit:read',
  // Operational (system administrator)
  'scan:trigger',
  'findings:write', // edit manual STIG check status / comments / details
  'remediation:execute',
  'stig:import',
  'emass:push',
  // Security officer authoring
  'poam:write',
  'exception:write',
  // Manager approvals (separation of duties: distinct from execution)
  'poam:approve',
  'exception:approve',
  'remediation:approve',
  'roles:assign',
  // Global platform administration
  'collection:manage',
  'users:manage',
  'notifications:manage',
  'scan:schedule',
  'updates:manage',
  'power:schedule',
  'emass:configure',
  // Reporting what the scheduler *did*, as opposed to deciding the policy.
  // Held by the scheduler Function's own identity, which is an operator.
  'updates:report',
  'power:report',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Permissions that are inherently tenant-wide and never scoped to a single
 * Collection. A global grant of one of these is required; a Collection-scoped
 * binding can never satisfy them.
 */
export const GLOBAL_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'collection:manage',
  'users:manage',
  'notifications:manage',
  'scan:schedule',
  'updates:manage',
  'power:schedule',
  'emass:configure',
  'updates:report',
  'power:report',
  'audit:read',
  'stig:import',
]);

/** Incremental permissions introduced at each role tier. */
const ROLE_GRANTS: Record<Role, Permission[]> = {
  auditor: ['dashboard:read', 'export:generate', 'audit:read'],
  operator: [
    'scan:trigger',
    'findings:write',
    'remediation:execute',
    'stig:import',
    'emass:push',
    // The scheduler Function runs as an operator and must be able to report
    // its check-ins and shutdowns. Deliberately separate from
    // 'power:schedule': reporting what happened is not the same authority as
    // deciding when the estate powers down, which stays with admins.
    'updates:report',
    'power:report',
  ],
  isso: ['poam:write', 'exception:write'],
  issm: [
    'poam:approve',
    'exception:approve',
    'remediation:approve',
    'roles:assign',
  ],
  admin: [
    'collection:manage',
    'users:manage',
    'notifications:manage',
    'scan:schedule',
    'updates:manage',
    'power:schedule',
    'emass:configure',
  ],
};

/**
 * Cumulative role → permission map. Each role includes every permission of the
 * roles below it in the hierarchy, plus its own incremental grants.
 */
export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = (() => {
  const ordered = [...ROLES].sort((a, b) => ROLE_RANK[a] - ROLE_RANK[b]);
  const acc: Permission[] = [];
  const out = {} as Record<Role, ReadonlySet<Permission>>;
  for (const role of ordered) {
    acc.push(...ROLE_GRANTS[role]);
    out[role] = new Set(acc);
  }
  return out;
})();

/** True when `value` is a recognized role. */
export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** True when `permission` is global (tenant-wide, never Collection-scoped). */
export function isGlobalPermission(permission: Permission): boolean {
  return GLOBAL_PERMISSIONS.has(permission);
}

/** Filters an arbitrary string list down to recognized roles. */
export function toRoles(values: readonly string[]): Role[] {
  return values.filter(isRole);
}

/** The union of permissions granted by a set of roles. */
export function permissionsForRoles(
  roles: Iterable<string>,
): ReadonlySet<Permission> {
  const out = new Set<Permission>();
  for (const role of roles) {
    if (!isRole(role)) continue;
    for (const perm of ROLE_PERMISSIONS[role]) {
      out.add(perm);
    }
  }
  return out;
}

/** True when any of `roles` grants `permission`. */
export function rolesGrant(
  roles: readonly string[],
  permission: Permission,
): boolean {
  return permissionsForRoles(roles).has(permission);
}
