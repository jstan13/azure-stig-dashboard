/**
 * Express request augmentation for the authentication / authorization layer.
 *
 * These properties are attached by middleware:
 *   - `principal`      — canonical validated identity (see authn.ts)
 *   - `auth`           — legacy identity shape kept for routes not yet migrated
 *   - `audit`          — audit sink (see auth/audit.ts)
 *   - `correlationId`  — per-request correlation id
 *   - `authzScope`     — Collection id resolved for the current route, if any
 */
import type { AuthenticatedPrincipal } from '../auth/jwt';
import type { AuditSink } from '../auth/audit';

/** Legacy identity shape produced by the original express-jwt middleware. */
export interface LegacyAuth {
  sub: string;
  oid: string;
  name?: string;
  email?: string;
  roles: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      principal?: AuthenticatedPrincipal;
      auth?: LegacyAuth;
      audit?: AuditSink;
      correlationId?: string;
      authzScope?: string | undefined;
    }
  }
}

export {};
