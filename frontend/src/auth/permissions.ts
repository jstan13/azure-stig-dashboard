/**
 * Frontend mirror of the backend permission catalog (backend/src/auth/permissions.ts).
 *
 * Kept in sync manually. The frontend never makes the authorization decision —
 * it only uses these to show/hide UI. The backend re-checks every request.
 */

export const PERMISSIONS = [
  'dashboard:read',
  'export:generate',
  'audit:read',
  'scan:trigger',
  'findings:write',
  'remediation:execute',
  'stig:import',
  'emass:push',
  'poam:write',
  'exception:write',
  'poam:approve',
  'exception:approve',
  'remediation:approve',
  'roles:assign',
  'collection:manage',
  'users:manage',
  'notifications:manage',
  'scan:schedule',
  'updates:manage',
  'power:schedule',
  'power:report',
  'emass:configure',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ['auditor', 'operator', 'isso', 'issm', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/** Human-friendly labels for the RMF personas (for admin UI dropdowns). */
export const ROLE_LABELS: Record<Role, string> = {
  auditor: 'Auditor / Assessor (read + report)',
  operator: 'System Administrator (operate + edit checks)',
  isso: 'ISSO (POA&M / exception authoring)',
  issm: 'ISSM (approvals)',
  admin: 'Administrator (full control)',
};
