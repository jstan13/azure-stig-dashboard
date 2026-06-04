/**
 * JWT validator (constitution Principle I, FR-001).
 *
 * Validates Microsoft Entra-issued JWTs against:
 *   - signature (via the issuer's JWKS, with TTL-bounded in-memory cache)
 *   - audience
 *   - issuer (allowlist)
 *   - exp / nbf
 *   - presence of a `kid` header
 *
 * On success, returns a canonical principal extracted from the token's
 * standard claims. RBAC decisions happen in `./rbac.ts` and are NOT made
 * here.
 *
 * Design notes:
 *   - JWKS fetching is injectable so tests can inject deterministic keys.
 *     In production code, `defaultJwksFetcher()` performs an HTTPS GET
 *     against `https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys`.
 *   - We use `jose` rather than `express-jwt` so the validator is reusable
 *     from Functions handlers and Service Bus consumers, and so we own the
 *     JWKS cache lifecycle.
 *   - This validator is the single token-validation entry point; the
 *     `authenticate` middleware (middleware/authn.ts) calls it on every
 *     request to populate `req.principal`.
 */
import {
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  type JWK,
  type KeyLike,
} from 'jose';

export type JwtFailureReason =
  | 'expired'
  | 'aud'
  | 'iss'
  | 'kid'
  | 'signature'
  | 'jwks_unavailable'
  | 'malformed'
  | 'unknown';

export class JwtValidationError extends Error {
  public override readonly name = 'JwtValidationError';
  public readonly reason: JwtFailureReason;
  public readonly cause: unknown;

  constructor(reason: JwtFailureReason, message: string, cause?: unknown) {
    super(message);
    this.reason = reason;
    this.cause = cause;
  }
}

export interface AuthenticatedPrincipal {
  /** The token's `sub` claim. */
  subject: string;
  /** The token's `oid` claim — Entra object ID. May equal subject. */
  objectId: string;
  /** UPN claim (username@tenant.onmicrosoft.com) when present. */
  upn: string | undefined;
  /** Display name from the `name` claim. */
  name: string | undefined;
  /** App roles from the `roles` claim. Empty array when absent. */
  appRoles: string[];
  /**
   * Entra security-group object IDs from the `groups` claim. Empty array when
   * absent. Used to map directory groups onto dashboard roles.
   */
  groups: string[];
  /**
   * True when Entra omitted the `groups` claim because the user is a member of
   * more groups than the token can carry (the "groups overage" case, signalled
   * by `_claim_names`/`_claim_sources`). When true, group-derived roles cannot
   * be resolved from the token alone and require a Microsoft Graph callback.
   */
  groupsOverage: boolean;
  /** The original validated payload, for any consumer needing extra claims. */
  rawPayload: Record<string, unknown>;
}

export type JwksFetcher = () => Promise<{ keys: JWK[] }>;

export interface JwtValidatorConfig {
  /** Expected `aud` claim, e.g. `api://<client-id>`. */
  audience: string;
  /** Allowlist of acceptable `iss` values (Entra issues v1 + v2). */
  issuers: string[];
  /** JWKS cache TTL in milliseconds. Defaults to 1 hour. */
  jwksTtlMs?: number;
  /** Fetcher for the issuer's JWKS document. Injectable for tests. */
  jwksFetcher: JwksFetcher;
  /** Clock injection for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

interface JwksCacheEntry {
  fetchedAt: number;
  keysByKid: Map<string, KeyLike>;
}

export class JwtValidator {
  private readonly cfg: Required<Omit<JwtValidatorConfig, 'jwksFetcher' | 'now'>> &
    Pick<JwtValidatorConfig, 'jwksFetcher' | 'now'>;
  private cache: JwksCacheEntry | undefined;

  constructor(cfg: JwtValidatorConfig) {
    this.cfg = {
      audience: cfg.audience,
      issuers: [...cfg.issuers],
      jwksTtlMs: cfg.jwksTtlMs ?? 60 * 60 * 1000,
      jwksFetcher: cfg.jwksFetcher,
      now: cfg.now,
    };
  }

  async validate(token: string): Promise<AuthenticatedPrincipal> {
    let header;
    try {
      header = decodeProtectedHeader(token);
    } catch (err) {
      throw new JwtValidationError('malformed', 'token is not a valid JWS', err);
    }

    if (!header.kid) {
      throw new JwtValidationError(
        'kid',
        'token header is missing a "kid" claim',
      );
    }

    const key = await this.resolveKey(header.kid);

    let payload: Record<string, unknown>;
    try {
      // NOTE: the injectable `now` clock governs only JWKS cache TTL
      // bookkeeping (see resolveKey/refresh); JWT temporal claims (exp/nbf)
      // are always validated against real wall-clock time.
      const verified = await jwtVerify(token, key, {
        audience: this.cfg.audience,
        issuer: this.cfg.issuers,
        algorithms: ['RS256'],
      });
      payload = verified.payload as Record<string, unknown>;
    } catch (err) {
      throw mapJoseError(err);
    }

    return toPrincipal(payload);
  }

  private async resolveKey(kid: string): Promise<KeyLike> {
    const now = this.cfg.now ? this.cfg.now() : Date.now();
    if (
      !this.cache ||
      now - this.cache.fetchedAt >= this.cfg.jwksTtlMs ||
      !this.cache.keysByKid.has(kid)
    ) {
      await this.refresh(now);
    }
    const key = this.cache?.keysByKid.get(kid);
    if (!key) {
      throw new JwtValidationError(
        'kid',
        `no JWKS key matches kid "${kid}"`,
      );
    }
    return key;
  }

  private async refresh(now: number): Promise<void> {
    let jwks;
    try {
      jwks = await this.cfg.jwksFetcher();
    } catch (err) {
      throw new JwtValidationError(
        'jwks_unavailable',
        'JWKS fetcher failed',
        err,
      );
    }
    const keysByKid = new Map<string, KeyLike>();
    for (const jwk of jwks.keys) {
      if (typeof jwk.kid !== 'string') continue;
      const key = (await importJWK(jwk, jwk.alg ?? 'RS256')) as KeyLike;
      keysByKid.set(jwk.kid, key);
    }
    this.cache = { fetchedAt: now, keysByKid };
  }
}

function toPrincipal(
  payload: Record<string, unknown>,
): AuthenticatedPrincipal {
  const subject = mustString(payload, 'sub');
  const objectId = optionalString(payload, 'oid') ?? subject;
  const upn = optionalString(payload, 'upn') ?? optionalString(payload, 'preferred_username');
  const name = optionalString(payload, 'name');
  const rolesRaw = payload.roles;
  const appRoles = Array.isArray(rolesRaw)
    ? rolesRaw.filter((r): r is string => typeof r === 'string')
    : [];
  const groupsRaw = payload.groups;
  const groups = Array.isArray(groupsRaw)
    ? groupsRaw.filter((g): g is string => typeof g === 'string')
    : [];
  // Entra signals a groups overage by emitting `_claim_names.groups` pointing
  // at a `_claim_sources` Graph URL instead of the inline `groups` array.
  const claimNames = payload._claim_names;
  const groupsOverage =
    groups.length === 0 &&
    typeof claimNames === 'object' &&
    claimNames !== null &&
    'groups' in (claimNames as Record<string, unknown>);
  return { subject, objectId, upn, name, appRoles, groups, groupsOverage, rawPayload: payload };
}

function mustString(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new JwtValidationError(
      'malformed',
      `payload is missing required string claim "${key}"`,
    );
  }
  return v;
}

function optionalString(
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = payload[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function mapJoseError(err: unknown): JwtValidationError {
  // jose error codes per https://github.com/panva/jose/blob/main/docs/classes/util_errors.JOSEError.md
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code: unknown }).code)
      : '';
  // jose attaches the offending claim name (e.g. 'aud', 'iss', 'exp', 'nbf')
  // to JWTClaimValidationFailed / JWTExpired errors.
  const claim =
    err && typeof err === 'object' && 'claim' in err
      ? String((err as { claim: unknown }).claim)
      : '';
  const msg = err instanceof Error ? err.message : String(err);

  if (code === 'ERR_JWT_EXPIRED' || claim === 'exp' || /expired/i.test(msg)) {
    return new JwtValidationError('expired', msg, err);
  }
  if (claim === 'aud' || /audience/i.test(msg)) {
    return new JwtValidationError('aud', msg, err);
  }
  if (claim === 'iss' || /issuer/i.test(msg)) {
    return new JwtValidationError('iss', msg, err);
  }
  if (
    code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' ||
    /signature/i.test(msg)
  ) {
    return new JwtValidationError('signature', msg, err);
  }
  return new JwtValidationError('unknown', msg, err);
}

/**
 * Production JWKS fetcher hitting Microsoft Entra's discovery endpoint.
 *
 * Cloud-aware: honors `AZURE_AUTHORITY_HOST` (set by the ARM/Bicep templates)
 * so deployments to Azure US Government / DoD point at
 * `https://login.microsoftonline.us/<tenant>/discovery/v2.0/keys` instead of
 * the Commercial endpoint. Tests inject their own fetcher and ignore this.
 */
export function defaultJwksFetcher(tenantId: string, authorityHost?: string): JwksFetcher {
  const host = (authorityHost ?? process.env.AZURE_AUTHORITY_HOST ?? 'https://login.microsoftonline.com').replace(/\/+$/, '');
  const url = `${host}/${tenantId}/discovery/v2.0/keys`;
  return async () => {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`JWKS HTTP ${res.status} from ${url}`);
    }
    return (await res.json()) as { keys: JWK[] };
  };
}
