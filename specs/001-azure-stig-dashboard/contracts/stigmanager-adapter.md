# STIG Manager Adapter — Contract

> Optional integration. Activated when `STIGMAN_INTEGRATION=enabled` and the
> required configuration keys are set. When disabled, the local Postgres is
> the system of record and this adapter is not loaded.

## Goals

- Use NUWCDIVNPT STIG Manager (OpenAPI 3.0.1, REST) as the **system of
  record** for Collections, Assets, Reviews (Findings), and Stigs (Benchmark
  versions).
- Keep this product as the **Azure-aware ingestion + UI layer**.
- Preserve constitution Principle IV (full traceability) on the integration
  boundary: every API call carries the same `mappingChain` we'd persist
  locally.

## Configuration

| Key | Description |
|-----|-------------|
| `STIGMAN_INTEGRATION` | `enabled` or `disabled` (default `disabled`) |
| `STIGMAN_BASE_URL` | e.g., `https://stigman.internal.contoso.com/api` |
| `STIGMAN_OIDC_AUTHORITY` | Keycloak/Entra authority used by STIG Manager |
| `STIGMAN_AUDIENCE` | OIDC audience for the STIG Manager API |
| `STIGMAN_CLIENT_ID_REF` | Key Vault reference (no plaintext) |
| `STIGMAN_TIMEOUT_MS` | default `15000` |

When enabled, the adapter authenticates via OAuth client credentials with the
configured client id, exchanging tokens against `STIGMAN_OIDC_AUTHORITY`.

## Mapping (this product ↔ STIG Manager)

| This product | STIG Manager | Notes |
|--------------|--------------|-------|
| Collection | Collection | 1:1; we mirror the GUID and persist it on our `Collection.externalId` |
| Asset | Asset | 1:1; mapped on `azureResourceId`; STIG Manager `metadata.azureResourceId` is the join key |
| BenchmarkVersion | STIG | We resolve by Title+Version+Release; ContentPack governs which versions exist |
| Rule | Rule | by Vuln_Num within a STIG |
| Finding | Review | one Review per (Asset, Rule); status mapped: Open↔O, NotAFinding↔NF, Not_Applicable↔NA, Not_Reviewed↔NR |
| Exception | Review with `evaluated=false` and a comment tag `EXCEPTION:<exception-id>` until STIG Manager native support is used |
| AuditLog | (local only) | We do not mirror audit to STIG Manager; STIG Manager has its own audit |

## Operations

### On scan completion (write-through)

```text
For each finding produced:
  PUT /collections/{cId}/reviews/{aId}/{ruleId}
  body:
    result: <mapped-status>
    detail: { text: finding.findingDetails }
    comment: { text: finding.comments }
    metadata:
      azureResourceId: ...
      benchmarkSha256: ...
      mappingChain: ...
      correlationId: ...
```

### On `.ckl`/`.cklb` import (write-through)

Map import to N reviews; one PUT each. Failures are recorded in the local
`ImportResult` with the offending rule ID and STIG Manager error body.

### On exception lifecycle

For each ExceptionTarget, write/update the corresponding Review with the
exception state in `metadata.exception`. On expiry, write the Review back to
its prior automated status, or `Not_Reviewed` if no recent automated finding
exists.

### On read

When `STIGMAN_INTEGRATION=enabled` *and* `STIGMAN_AUTHORITATIVE=true`,
findings/Reviews are read from STIG Manager and the local Findings table acts
as a denormalized cache (write-behind, last-writer-wins for non-evaluated
fields). When `STIGMAN_AUTHORITATIVE=false` (default), local data wins on
read; the adapter only writes through.

## Error model

The adapter MUST:
- retry transient errors (HTTP 5xx, network timeouts) with exponential backoff
  up to 3 attempts;
- surface 4xx errors back to the caller with the STIG Manager response body;
- emit a `StigManager.WriteFailed` audit record on permanent failure;
- never silently swallow a write — if STIG Manager rejects a Review, the
  finding remains visible in this product with a `SyncFailed` flag.

## Tests

- Pact-style consumer tests against a recorded STIG Manager OpenAPI fixture
  (vendored under `backend/tests/fixtures/stigman/`).
- Integration tests gated behind `STIGMAN_E2E=true` in CI; run nightly
  against an ephemeral STIG Manager Container Apps deployment.
- Mapping unit tests: every Finding status round-trips through the mapping
  table without loss.

## Open questions (post-MVP)

- Replace the `metadata.exception` workaround with STIG Manager's native
  exceptions API once stabilized.
- Decide whether to push AuditLog mirror records to STIG Manager's own log
  ingest endpoint when available.
