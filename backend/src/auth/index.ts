/**
 * Public surface of the auth layer.
 *
 * Authorization is permission-based: middleware resolves a principal's roles
 * (global + Collection-scoped) via `roleResolver`, then decides with `can`
 * against the `permissions` catalog. The legacy role-rank `authorize`/`rbac`
 * helpers remain only for the unit tests that still exercise them.
 */
export {
  JwtValidator,
  JwtValidationError,
  defaultJwksFetcher,
  type AuthenticatedPrincipal,
  type JwksFetcher,
  type JwtValidatorConfig,
} from './jwt';

export {
  authorize,
  RbacDeniedError,
  type RoleBinding,
  type RoleBindingLookup,
  type AuthorizedPrincipal,
  type AuthorizeArgs,
} from './rbac';

export {
  ROLES,
  PERMISSIONS,
  ROLE_RANK,
  ROLE_PERMISSIONS,
  GLOBAL_PERMISSIONS,
  isRole,
  isGlobalPermission,
  toRoles,
  permissionsForRoles,
  rolesGrant,
  type Role,
  type Permission,
} from './permissions';

export {
  Auditor,
  auditMiddleware,
  type AuditEntry,
  type AuditInput,
  type AuditWriter,
  type AuditSink,
  type AuditResult,
  type AuditRequest,
  type AuditMiddlewareOptions,
  type FallbackLog,
  type FallbackLogPayload,
} from './audit';

export { recordAudit, type RouteAuditInput } from './recordAudit';
