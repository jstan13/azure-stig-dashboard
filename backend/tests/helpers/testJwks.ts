/**
 * Test helper — generates an RSA keypair at module load and exposes:
 *   - a `signTestJwt` function that issues tokens with arbitrary claims
 *   - a `getTestJwks` function returning the matching JWKS
 *   - a `getTestJwksFetcher` returning an injectable fetcher compatible with
 *     `backend/src/auth/jwt.ts`'s constructor signature.
 *
 * The keypair is generated once per test process to keep tests fast.
 *
 * Tests for `backend/src/auth/jwt.ts` MUST inject this fetcher rather than
 * letting the validator hit the real Microsoft JWKS endpoint.
 */
import { generateKeyPair, exportJWK, SignJWT, type JWK } from 'jose';

/**
 * jose v6 dropped the exported `KeyLike` alias; derive the key type from
 * `generateKeyPair` so this stays correct across jose versions.
 */
type KeyLike = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

export interface TestJwtClaims {
  sub?: string;
  oid?: string;
  upn?: string;
  email?: string;
  name?: string;
  roles?: string[];
  /** Override for the `aud` claim; defaults to `api://test-client` */
  audience?: string;
  /** Override for the `iss` claim; defaults to the Entra v2 issuer for `test-tenant` */
  issuer?: string;
  /** Optional override for `exp` in seconds since epoch */
  exp?: number;
  /** Optional override for `nbf` in seconds since epoch */
  nbf?: number;
  /** Optional override for `kid` — useful to test the missing-kid path */
  kid?: string | null;
}

const DEFAULT_TENANT = 'test-tenant';
const DEFAULT_CLIENT = 'test-client';
const DEFAULT_KID = 'test-kid-1';

let cachedKeyPair: { privateKey: KeyLike; publicKey: KeyLike } | undefined;
let cachedJwk: JWK | undefined;

async function ensureKeys(): Promise<{
  privateKey: KeyLike;
  publicKey: KeyLike;
  publicJwk: JWK;
}> {
  if (!cachedKeyPair || !cachedJwk) {
    const kp = await generateKeyPair('RS256', { extractable: true });
    cachedKeyPair = kp;
    const jwk = await exportJWK(kp.publicKey);
    jwk.kid = DEFAULT_KID;
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    cachedJwk = jwk;
  }
  return {
    privateKey: cachedKeyPair.privateKey,
    publicKey: cachedKeyPair.publicKey,
    publicJwk: cachedJwk,
  };
}

export async function signTestJwt(claims: TestJwtClaims = {}): Promise<string> {
  const { privateKey } = await ensureKeys();
  const now = Math.floor(Date.now() / 1000);
  const audience = claims.audience ?? `api://${DEFAULT_CLIENT}`;
  const issuer =
    claims.issuer ?? `https://login.microsoftonline.com/${DEFAULT_TENANT}/v2.0`;

  const header: { alg: string; typ: string; kid?: string } = { alg: 'RS256', typ: 'JWT' };
  if (claims.kid !== null) {
    header.kid = claims.kid ?? DEFAULT_KID;
  }

  const payload: Record<string, unknown> = {
    sub: claims.sub ?? 'test-subject',
    oid: claims.oid ?? 'test-oid-0001',
    upn: claims.upn ?? 'test.user@example.onmicrosoft.com',
    email: claims.email ?? 'test.user@example.onmicrosoft.com',
    name: claims.name ?? 'Test User',
    roles: claims.roles ?? [],
  };

  return new SignJWT(payload)
    .setProtectedHeader(header)
    .setIssuedAt(now)
    .setNotBefore(claims.nbf ?? now - 5)
    .setExpirationTime(claims.exp ?? now + 300)
    .setAudience(audience)
    .setIssuer(issuer)
    .sign(privateKey);
}

export async function getTestJwks(): Promise<{ keys: JWK[] }> {
  const { publicJwk } = await ensureKeys();
  return { keys: [publicJwk] };
}

/**
 * Returns a fetcher implementation suitable for injection into the JWT
 * validator. Calls are tracked via the returned `calls` counter so tests can
 * assert caching behavior.
 */
export function getTestJwksFetcher(): {
  fetch: () => Promise<{ keys: JWK[] }>;
  callCount: () => number;
  reset: () => void;
} {
  let calls = 0;
  return {
    fetch: async () => {
      calls += 1;
      return getTestJwks();
    },
    callCount: () => calls,
    reset: () => {
      calls = 0;
    },
  };
}

export const TEST_JWT_DEFAULTS = {
  tenant: DEFAULT_TENANT,
  clientId: DEFAULT_CLIENT,
  audience: `api://${DEFAULT_CLIENT}`,
  issuer: `https://login.microsoftonline.com/${DEFAULT_TENANT}/v2.0`,
  kid: DEFAULT_KID,
} as const;
