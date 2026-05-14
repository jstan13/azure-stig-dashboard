/**
 * Failing-first unit tests for backend/src/auth/jwt.ts (constitution VII).
 *
 * Covers:
 *   - valid token → returns canonical principal
 *   - expired token → throws JwtValidationError('expired')
 *   - wrong audience → throws JwtValidationError('aud')
 *   - wrong issuer → throws JwtValidationError('iss')
 *   - missing kid → throws JwtValidationError('kid')
 *   - JWKS fetcher unreachable → throws JwtValidationError('jwks_unavailable')
 *   - JWKS is cached for the configured TTL (second validate within TTL
 *     does not refetch)
 *   - JWKS is refetched after TTL expires
 *
 * Tests inject a deterministic JWKS fetcher; no network calls.
 */
import {
  signTestJwt,
  getTestJwksFetcher,
  TEST_JWT_DEFAULTS,
} from '../../helpers/testJwks';
import {
  JwtValidator,
  JwtValidationError,
} from '../../../src/auth/jwt';

const baseConfig = () => ({
  audience: TEST_JWT_DEFAULTS.audience,
  issuers: [TEST_JWT_DEFAULTS.issuer],
  jwksTtlMs: 60 * 60 * 1000,
});

describe('JwtValidator', () => {
  it('accepts a valid token and returns canonical principal claims', async () => {
    const fetcher = getTestJwksFetcher();
    const v = new JwtValidator({ ...baseConfig(), jwksFetcher: fetcher.fetch });
    const token = await signTestJwt({ roles: ['admin', 'auditor'] });

    const principal = await v.validate(token);

    expect(principal.subject).toBe('test-subject');
    expect(principal.objectId).toBe('test-oid-0001');
    expect(principal.upn).toBe('test.user@example.onmicrosoft.com');
    expect(principal.appRoles.sort()).toEqual(['admin', 'auditor']);
  });

  it('rejects an expired token with reason "expired"', async () => {
    const fetcher = getTestJwksFetcher();
    const v = new JwtValidator({ ...baseConfig(), jwksFetcher: fetcher.fetch });
    const past = Math.floor(Date.now() / 1000) - 10;
    const token = await signTestJwt({ exp: past, nbf: past - 100 });

    await expect(v.validate(token)).rejects.toMatchObject({
      name: 'JwtValidationError',
      reason: 'expired',
    } satisfies Partial<JwtValidationError>);
  });

  it('rejects a token with the wrong audience with reason "aud"', async () => {
    const fetcher = getTestJwksFetcher();
    const v = new JwtValidator({ ...baseConfig(), jwksFetcher: fetcher.fetch });
    const token = await signTestJwt({ audience: 'api://wrong-client' });

    await expect(v.validate(token)).rejects.toMatchObject({
      reason: 'aud',
    });
  });

  it('rejects a token with the wrong issuer with reason "iss"', async () => {
    const fetcher = getTestJwksFetcher();
    const v = new JwtValidator({ ...baseConfig(), jwksFetcher: fetcher.fetch });
    const token = await signTestJwt({
      issuer: 'https://login.microsoftonline.com/another-tenant/v2.0',
    });

    await expect(v.validate(token)).rejects.toMatchObject({
      reason: 'iss',
    });
  });

  it('rejects a token whose header has no "kid" with reason "kid"', async () => {
    const fetcher = getTestJwksFetcher();
    const v = new JwtValidator({ ...baseConfig(), jwksFetcher: fetcher.fetch });
    const token = await signTestJwt({ kid: null });

    await expect(v.validate(token)).rejects.toMatchObject({
      reason: 'kid',
    });
  });

  it('reports "jwks_unavailable" when the JWKS fetcher throws', async () => {
    const v = new JwtValidator({
      ...baseConfig(),
      jwksFetcher: async () => {
        throw new Error('network down');
      },
    });
    const token = await signTestJwt();

    await expect(v.validate(token)).rejects.toMatchObject({
      reason: 'jwks_unavailable',
    });
  });

  it('caches JWKS for the configured TTL across multiple validate calls', async () => {
    const fetcher = getTestJwksFetcher();
    const v = new JwtValidator({
      ...baseConfig(),
      jwksTtlMs: 60_000,
      jwksFetcher: fetcher.fetch,
    });
    const token = await signTestJwt();

    await v.validate(token);
    await v.validate(token);
    await v.validate(token);

    expect(fetcher.callCount()).toBe(1);
  });

  it('refetches JWKS after the cache TTL elapses', async () => {
    const fetcher = getTestJwksFetcher();
    let now = 1_000_000_000_000;
    const clock = () => now;
    const v = new JwtValidator({
      ...baseConfig(),
      jwksTtlMs: 1_000,
      jwksFetcher: fetcher.fetch,
      now: clock,
    });
    const token = await signTestJwt();

    await v.validate(token);
    expect(fetcher.callCount()).toBe(1);

    now += 2_000; // advance past TTL
    await v.validate(token);
    expect(fetcher.callCount()).toBe(2);
  });
});
