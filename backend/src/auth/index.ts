/**
 * Public surface of the spec-aligned auth layer.
 *
 * Routes should migrate from `backend/src/middleware/auth.ts` to these
 * primitives over time. Until they do, both layers coexist.
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
  type Role,
  type RoleBinding,
  type RoleBindingLookup,
  type AuthorizedPrincipal,
  type AuthorizeArgs,
} from './rbac';

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
