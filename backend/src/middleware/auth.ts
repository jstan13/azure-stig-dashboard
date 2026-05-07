import { Request, Response, NextFunction } from 'express';
import { expressjwt } from 'express-jwt';
import jwksRsa from 'jwks-rsa';
import { logger } from '../utils/logger';

const TENANT_ID = process.env.AZURE_TENANT_ID || '';
const CLIENT_ID = process.env.AZURE_CLIENT_ID || '';
const MOCK_MODE = process.env.MOCK_MODE === 'true';

// Cloud-aware Microsoft Entra authority. Defaults to Azure Commercial; the
// ARM/Bicep templates set AZURE_AUTHORITY_HOST to https://login.microsoftonline.us
// for Azure US Government / DoD deployments.
const AUTHORITY_HOST = (process.env.AZURE_AUTHORITY_HOST || 'https://login.microsoftonline.com').replace(/\/+$/, '');
const AUTHORITY_HOST_BARE = AUTHORITY_HOST.replace(/^https?:\/\//, '');
const STS_HOST = AUTHORITY_HOST_BARE.replace('login.microsoftonline', 'sts.windows');

/**
 * Validates an Azure AD JWT bearer token.
 * In MOCK_MODE the middleware injects a synthetic admin user
 * so the app can be exercised without a real Azure AD tenant.
 */
const jwtCheck = expressjwt({
  secret: jwksRsa.expressJwtSecret({
    cache: true,
    rateLimit: true,
    jwksRequestsPerMinute: 5,
    jwksUri: `${AUTHORITY_HOST}/${TENANT_ID}/discovery/v2.0/keys`,
  }) as any,
  audience: `api://${CLIENT_ID}`,
  issuer: [
    `${AUTHORITY_HOST}/${TENANT_ID}/v2.0`,
    `https://${STS_HOST}/${TENANT_ID}/`,
  ],
  algorithms: ['RS256'],
});

export function authenticateToken(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (MOCK_MODE) {
    // Inject a mock user — useful for local dev and demos
    (req as any).auth = {
      sub: 'mock-user-001',
      name: 'Demo Admin',
      email: 'admin@demo.onmicrosoft.com',
      roles: ['admin'],
      oid: 'mock-oid-001',
    };
    return next();
  }

  jwtCheck(req, res, (err) => {
    if (err) {
      logger.warn(`JWT validation failed: ${err.message}`);
      res.status(401).json({ error: 'Unauthorized', message: err.message });
      return;
    }
    next();
  });
}

/**
 * Require one or more RBAC roles.
 * Roles are extracted from the `roles` claim in the Azure AD token.
 * Roles: admin | operator | auditor
 */
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const auth = (req as any).auth;
    if (!auth) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userRoles: string[] = auth.roles || [];
    const hasRole = roles.some((r) => userRoles.includes(r));

    if (!hasRole) {
      logger.warn(
        `Access denied for user ${auth.email || auth.sub} — required: ${roles.join('|')}, actual: ${userRoles.join(',')}`,
      );
      res.status(403).json({
        error: 'Forbidden',
        message: `Requires one of roles: ${roles.join(', ')}`,
      });
      return;
    }

    next();
  };
}
