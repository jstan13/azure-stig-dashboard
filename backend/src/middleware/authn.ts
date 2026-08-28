/**
 * Identity middleware — the canonical authentication layer.
 *
 * Replaces the legacy `express-jwt` middleware in `./auth.ts`. It validates the
 * incoming bearer token with the spec-aligned `JwtValidator` (jose), which is
 * reusable from Functions/Service Bus consumers and owns its own JWKS cache.
 *
 * On success it attaches the canonical `req.principal` (including Entra group
 * claims) AND, for backward compatibility while routes are migrated, the legacy
 * `req.auth` shape that older handlers and `recordAudit()` still read.
 *
 * MOCK_MODE preserves the original behaviour: a synthetic principal is injected
 * so the app runs with zero Azure credentials. The synthetic role is taken from
 * `MOCK_ROLE` (default `admin`) so demos can exercise every persona.
 */
import { Request, Response, NextFunction } from 'express';
import {
  JwtValidator,
  defaultJwksFetcher,
  JwtValidationError,
  type AuthenticatedPrincipal,
} from '../auth/jwt';
import { isRole, type Role } from '../auth/permissions';
import { logger } from '../utils/logger';

const MOCK_MODE = process.env.MOCK_MODE === 'true';
const TENANT_ID = process.env.AZURE_TENANT_ID || '';
const CLIENT_ID = process.env.AZURE_CLIENT_ID || '';

// Cloud-aware Microsoft Entra authority. Defaults to Azure Commercial; the
// ARM/Bicep templates set AZURE_AUTHORITY_HOST to https://login.microsoftonline.us
// for Azure US Government / DoD deployments.
const AUTHORITY_HOST = (
  process.env.AZURE_AUTHORITY_HOST || 'https://login.microsoftonline.com'
).replace(/\/+$/, '');
const AUTHORITY_HOST_BARE = AUTHORITY_HOST.replace(/^https?:\/\//, '');
const STS_HOST = AUTHORITY_HOST_BARE.replace('login.microsoftonline', 'sts.windows');

/** Lazily-constructed singleton validator (skipped entirely in MOCK_MODE). */
let validator: JwtValidator | undefined;
function getValidator(): JwtValidator {
  if (!validator) {
    validator = new JwtValidator({
      // Entra picks the audience from the app registration's
      // `requestedAccessTokenVersion`: v1 tokens are stamped with the App ID
      // URI, v2 tokens with the bare client id. Accept both so authentication
      // does not silently break when that setting changes.
      audience: [`api://${CLIENT_ID}`, CLIENT_ID],
      issuers: [
        `${AUTHORITY_HOST}/${TENANT_ID}/v2.0`,
        `https://${STS_HOST}/${TENANT_ID}/`,
      ],
      jwksFetcher: defaultJwksFetcher(TENANT_ID, AUTHORITY_HOST),
    });
  }
  return validator;
}

function mockPrincipal(): AuthenticatedPrincipal {
  const role: Role = isRole(process.env.MOCK_ROLE) ? process.env.MOCK_ROLE : 'admin';
  return {
    subject: 'mock-user-001',
    objectId: 'mock-oid-001',
    upn: 'admin@demo.onmicrosoft.com',
    name: 'Demo Admin',
    appRoles: [role],
    groups: [],
    groupsOverage: false,
    rawPayload: {},
  };
}

/** Projects the canonical principal onto the legacy `req.auth` shape. */
function toLegacyAuth(p: AuthenticatedPrincipal) {
  return {
    sub: p.subject,
    oid: p.objectId,
    name: p.name,
    email: p.upn,
    roles: p.appRoles,
  };
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  // Split on the first whitespace run rather than matching the whole header
  // with a regex: `/^Bearer\s+(.+)$/` backtracks quadratically (CWE-1333).
  const sep = header.search(/\s/);
  if (sep === -1) return undefined;
  if (header.slice(0, sep).toLowerCase() !== 'bearer') return undefined;
  const token = header.slice(sep).trim();
  return token.length > 0 ? token : undefined;
}

/**
 * Validates the bearer token and attaches `req.principal` + legacy `req.auth`.
 * Responds 401 on any validation failure.
 */
export function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (MOCK_MODE) {
    const principal = mockPrincipal();
    req.principal = principal;
    req.auth = toLegacyAuth(principal);
    next();
    return;
  }

  const token = bearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Unauthorized', message: 'Missing bearer token' });
    return;
  }

  getValidator()
    .validate(token)
    .then((principal) => {
      req.principal = principal;
      req.auth = toLegacyAuth(principal);
      next();
    })
    .catch((err: unknown) => {
      const reason = err instanceof JwtValidationError ? err.reason : 'unknown';
      logger.warn(`JWT validation failed (${reason})`);
      res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired token' });
    });
}
