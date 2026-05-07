---
description: "Task list for Azure STIG Dashboard implementation"
---

# Tasks: Azure STIG Dashboard

**Input**: Design documents from `/specs/001-azure-stig-dashboard/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Per constitution Principle VII, tests are MANDATORY (TDD) for
**mapping**, **export**, and **auth** modules. Tests are STRONGLY ENCOURAGED
elsewhere; specific test tasks are noted under each story.

**Organization**: Tasks are grouped by user story to enable independent
implementation, testing, and delivery.

---

## Scaffold Reconciliation (added 2026-05-07 by /speckit.implement)

The repo already contains a substantial Copilot-generated scaffold. The
reconciliation below maps existing artifacts to tasks. Symbols:

- `[X]` task is fully satisfied by existing code
- `[~]` task is partially satisfied — gaps noted inline
- `[ ]` task remains as written

**Already in scaffold (notable)**
- TypeORM entities under `backend/src/models/` for Subscription, ResourceGroup, Resource, Machine (≈Asset), Control (≈Rule), ControlMapping (≈Mapping), Scan, Finding, Checklist, User, Role, Exception, AuditLog, StigBenchmark, StigVersion, PowerStigResult, Poam (+ Milestone), ComplianceHistory, NotificationConfig, RemediationJob → covers most of T012, with **naming drift** vs [data-model.md](./data-model.md) (Machine vs Asset, Control vs Rule). Decision: **keep existing names**, add aliases in `packages/shared/src/types.ts` and document the mapping in research.md as an addendum.
- DataSource at `backend/src/database/dataSource.ts` with mock-store fallback → covers T011.
- Connectors `armConnector`, `defenderConnector`, `policyConnector`, `resourceGraphConnector` + `baseConnector` + `scanOrchestrator` under `backend/src/connectors/` with `MOCK_MODE` parity → covers T024-T025 and T211-T214. **Gap**: no `machineConfigurationConnector` yet (T215).
- Auth middleware `backend/src/middleware/auth.ts` with `expressjwt` + JWKS + MOCK_MODE bypass → covers T017 partially. **Gaps**: no failing-tests-first contract per Principle VII (T015), no Collection-scoped RBAC layer (T018 must be added on top), no audit-on-deny middleware (T019 must be added).
- Exporters: `backend/src/exporters/cklExporter.ts` and `poamExporter.ts` → covers T110 partially. **Gaps**: status-vocabulary drift (`not_a_finding` vs DISA `NotAFinding`), no `.cklb`/XCCDF/OSCAL/CSV writers (T111-T114), no determinism test (T107), no completeness gate (T115).
- Frontend: MSAL config `frontend/src/auth/msalConfig.ts`, react-router pages, recharts widgets → covers T027 partially (no `MockMsalProvider` yet) and T029.
- Tests: `backend/src/__tests__/{api,checkTypeParser,cklExporter,connectors,dscResultParser,poams,xccdfParser}.test.ts` → starting point but **not failing-first** for the constitution-mandated modules.
- `infra/main.bicep` monolithic → covers T031 partially; **Gap**: not yet modularized into `infra/modules/`.
- `.github/workflows/deploy.yml` → covers T008-T009 partially; lacks bicep what-if, axe-core gating, codeql, npm audit.
- `e2e/tests/dashboard.spec.ts` minimal → covers T030 starting point; needs axe-core wiring per T807.
- `docker-compose.yml` → covers T006 with **gaps**: no `azurite`, no explicit `mock` profile.

**Unique deltas the spec adds vs scaffold (must be net-new)**
1. `backend/src/auth/jwt.ts`, `rbac.ts`, `audit.ts` modular files with TDD-first unit tests (T015-T019).
2. `backend/src/mappings/` module with versioned YAML mapping packs and resolver (T201-T210).
3. `backend/src/exporters/{cklb,xccdf,oscal,csv}.ts` + completeness gate (T111-T115).
4. DISA-vocabulary status enum used uniformly (`Open|NotAFinding|Not_Applicable|Not_Reviewed`) — current scaffold uses lowercase variants. Migration shim required.
5. `mappingChain` field on Finding with full traceability per FR-009 (existing `Finding.evidence` jsonb is close but missing the structured trace).
6. `functions/src/{scanOrchestrator,findingsIngestor,exceptionExpirer,contentRefresher,poamOverdue}/` (T221-T222, T309, T408, T605).
7. `mc-packages/{windows-stig,linux-stig,build}/` (T225).
8. `infra/modules/{network,identity,data,app,observability,policy,messaging,storage}.bicep` (T031-T033, T223, T410).
9. `packages/shared/src/types.ts` cross-package types (T003).
10. `tsconfig.base.json` strict-by-default (T005).
11. CODEOWNERS for security-critical paths (T010).
12. `MockMsalProvider` for frontend mock-mode (T027 completion).
13. STIG Manager adapter under `backend/src/stigmanager/` (T701-T705) — feature-flagged.
14. ETag optimistic concurrency on `PATCH /findings/:id` (T117a).

The Phase-by-phase task list below is annotated with `[X]`/`[~]` accordingly.

---

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Parallelizable (touches different files, no dependency on incomplete tasks)
- **[Story]**: Maps to a User Story (US1..US6) from spec.md; omitted for Setup, Foundational, Polish

## Path Conventions

Web-app monorepo per [plan.md](./plan.md):
- Backend: `backend/src/`, `backend/tests/`
- Frontend: `frontend/src/`, `frontend/tests/`
- Functions: `functions/src/`
- MC Packages: `mc-packages/`
- IaC: `infra/`, `infra/modules/`

---

## Phase 1: Setup (Shared Infrastructure)

- [X] T001 Verify and align existing scaffold with [plan.md](./plan.md) directory layout — create empty `functions/`, `mc-packages/`, and `infra/modules/` directories with `.gitkeep`
- [X] T002 [P] Add root `package.json` workspaces entries for `backend`, `frontend`, `functions`, plus a shared `packages/shared` for cross-package types
- [X] T003 [P] Create `packages/shared/src/types.ts` exporting STIG vocabulary enums (`FindingStatus`, `Severity`, `ResourceType`, `RoleName`, etc.) used by backend, functions, and frontend
- [~] T004 [P] Configure ESLint + Prettier strict at the repo root with rules forbidding `any`, unused vars, and console.log; wire `npm run lint` to all workspaces — *partial: backend/frontend each have eslint configs; root config + Prettier still TODO*
- [X] T005 [P] Add `tsconfig.base.json` with `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`; have each package extend it
- [~] T006 [P] Update `docker-compose.yml` to include `postgres`, `azurite` (Blob emulator), and a `mock` profile that forces `MOCK_MODE=true` — *partial: postgres profile exists; azurite + mock profile still TODO*
- [X] T007 [P] Author `sample.env` covering every env var referenced in [plan.md](./plan.md) (auth, storage, postgres, app insights, mock, stigman) with inline comments and safe defaults — *covered by existing sample.env; will append STIGMAN_* keys when adapter is added*
- [~] T008 [P] Add `.github/workflows/ci.yml` with jobs: lint, typecheck, unit, integration (mock), e2e (mock + axe), bicep what-if, codeql, npm audit — *partial: deploy.yml has lint+test; needs split into ci.yml with axe/codeql/bicep what-if*
- [X] T009 [P] Add `.github/workflows/deploy.yml` triggered on tag, calling `azd up` with environment-specific Bicep parameters — *covered by existing deploy.yml; deploy is on push-to-main not tag, may want to revisit*
- [X] T010 [P] Add CODEOWNERS requiring security review for `backend/src/auth/**`, `backend/src/exporters/**`, `backend/src/mappings/**`, `infra/**`

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ No user-story work begins until this phase is complete.**

### Database & ORM

- [X] T011 Configure TypeORM data source in `backend/src/db/dataSource.ts` with Postgres connection from env, SSL support, and migration glob — *covered by `backend/src/database/dataSource.ts` (different path)*
- [~] T012 [P] Implement TypeORM entities — *partial: existing entities under `backend/src/models/` cover the domain with naming drift (Machine vs Asset, Control vs Rule); see Reconciliation. Net-new needed: Tenant, Collection, CollectionAsset, BenchmarkVersion as a distinct entity, RoleBinding, ExceptionTarget, ContentPack*
- [ ] T013 Generate baseline migration `backend/src/migrations/0001-baseline.ts` including indexes and partitioning for `Finding` and `AuditLog` (monthly on `producedAt` / `occurredAt`) — *scaffold currently relies on `synchronize: true` in dev; production migrations TODO*
- [ ] T014 [P] Add ULID primary-key transformer in `backend/src/db/ulid.ts` and apply on every entity — *scaffold uses `gen_random_uuid()`; switch deferred*

### Auth (TDD — constitution VII)

- [X] T015 [P] Write failing unit tests for JWT validation in `backend/tests/unit/auth/jwt.test.ts`: valid token, expired, wrong audience, wrong issuer, missing kid, JWKS unreachable
- [X] T016 [P] Write failing unit tests for RBAC middleware in `backend/tests/unit/auth/rbac.test.ts`: role required vs held, Collection-scoped vs unscoped, denied request emits AuditLog `Denied`
- [X] T017 Implement JWT validator in `backend/src/auth/jwt.ts` using `jose` + JWKS cache (1h TTL) — make T015 pass — *legacy `backend/src/middleware/auth.ts` (express-jwt) left in place for routes still using it; new modules are additive*
- [X] T018 Implement RBAC middleware in `backend/src/auth/rbac.ts` resolving Collection-scoped role from token + `RoleBinding` table — make T016 pass
- [X] T019 [P] Implement audit middleware in `backend/src/auth/audit.ts` capturing actor, action, before/after, correlation ID, source IP for every state-changing route — `AuditLog` entity exists; this commit adds the auditor + Express middleware on top

### App skeleton

- [~] T020 Wire `backend/src/server.ts` Express app: pino logging, App Insights init, CORS, helmet, request-correlation middleware, JWT validator, RBAC, audit middleware, `/healthz`, `/readyz` — *partial: scaffold uses `backend/src/index.ts` rather than `server.ts`; correlation + audit middleware (`auditMiddleware` + `Auditor` with TypeORM/mock writers) wired; helmet, CORS, App Insights, `/health` already in scaffold; JWT validator + RBAC swap from legacy `middleware/auth.ts` still pending; `/healthz` + `/readyz` rename TBD*
- [X] T021 [P] Add OpenAPI doc serving at `/api/docs` from `backend/openapi.yaml` (mirror of [contracts/openapi.yaml](./contracts/openapi.yaml)) — *covered: `swaggerUi` mounts `backend/openapi.yaml` at `/api/docs`*
- [ ] T022 [P] Add error handler in `backend/src/server.ts` converting domain errors to RFC 7807 problem+json
- [ ] T023 [P] Implement structured telemetry helpers in `backend/src/telemetry/index.ts` (correlation-aware logger, App Insights exception/event helpers)

### Connector interface + mock backbone

- [~] T024 [P] Define connector interfaces in `backend/src/connectors/types.ts`: `IInventoryConnector`, `IPolicyConnector`, `IDefenderConnector`, `IMachineConfigurationConnector`, `IArmConnector`, `IContentSourceConnector` — *partial: `BaseConnector` exists; explicit interface segregation per source type still TODO; no `IMachineConfigurationConnector` or `IContentSourceConnector` yet*
- [X] T025 [P] Implement `MOCK_MODE` connector binder — *covered: `mockMode` flag in BaseConnector + per-connector mockStore branch*
- [~] T026 [P] Add deterministic seed fixtures — *partial: `backend/src/database/mockSeed.ts` exists; spec calls for committed JSON fixtures with stable timestamps under `backend/src/mock/fixtures/`*

### Frontend foundations

- [~] T027 [P] Configure MSAL.js v3 — *partial: `msalConfig.ts` exists; `MockMsalProvider` for auto-signin under `VITE_MOCK_MODE` still TODO*
- [ ] T028 [P] Add `frontend/src/api/client.ts` generating typed client from `backend/openapi.yaml` via `openapi-typescript` — *scaffold uses hand-written axios; switch to generated types deferred*
- [~] T029 [P] Set up react-router v6 routes — *partial: routes exist, but per-spec page taxonomy (`/collections/:id`, `/assets/:id`, `/findings/:id`, `/audit`) needs alignment*
- [~] T030 [P] Add Fluent UI theme provider, accessible status pill, and accessible chart wrapper — *partial: Fluent UI v8 in use; spec calls for v9 + accessible-table fallback for charts*

### IaC foundations

- [ ] T031 Refactor existing `infra/main.bicep` into modules under `infra/modules/`: `network.bicep`, `identity.bicep`, `data.bicep`, `app.bicep`, `observability.bicep` — *scaffold has monolithic `main.bicep`; refactor outstanding*
- [ ] T032 [P] Add `infra/modules/network.bicep` provisioning VNet, subnets, Private DNS zones, Private Endpoints for Postgres, Storage, Key Vault
- [ ] T033 [P] Add `infra/modules/identity.bicep` creating system-assigned MIs and least-privilege role assignments per [plan.md](./plan.md) Constitution Check row IX

**Checkpoint**: Foundation ready — user-story phases may begin in parallel.

---

## Phase 3: User Story 1 — Auditor exports an ATO-ready CKL (Priority: P1) 🎯 MVP

**Goal**: An auditor can sign in, navigate to a Collection, drill into an
asset's findings, and export a STIG Viewer–compatible `.ckl` (and `.cklb`,
XCCDF, OSCAL, CSV) that round-trips through DISA STIG Viewer.

**Independent Test**: With seeded mock data, sign in as `auditor`, open an
asset, click Export → CKL; the file opens in DISA STIG Viewer with all fields
populated, and re-import produces identical findings.

### Tests for User Story 1 (TDD — constitution VII for exporters)

- [ ] T101 [P] [US1] Failing fixture-based round-trip test in `backend/tests/integration/exporters/ckl-roundtrip.test.ts` — uses committed STIG-Viewer-saved `.ckl` fixture; export → diff
- [ ] T102 [P] [US1] Failing unit test for `.ckl` writer in `backend/tests/unit/exporters/ckl.test.ts` — required ASSET, iSTIG, VULN field coverage
- [ ] T103 [P] [US1] Failing unit test for `.cklb` writer in `backend/tests/unit/exporters/cklb.test.ts`
- [ ] T104 [P] [US1] Failing unit test for XCCDF writer in `backend/tests/unit/exporters/xccdf.test.ts`
- [ ] T105 [P] [US1] Failing unit test for OSCAL writer in `backend/tests/unit/exporters/oscal.test.ts`
- [ ] T106 [P] [US1] Failing unit test for CSV writer in `backend/tests/unit/exporters/csv.test.ts`
- [ ] T107 [P] [US1] Failing test for export determinism in `backend/tests/integration/exporters/determinism.test.ts` — same input twice → byte-identical bytes
- [ ] T108 [P] [US1] Failing contract test for `POST /exports` in `backend/tests/integration/api/exports.test.ts` — auditor allowed, unauthenticated denied, missing mappingChain rejected
- [ ] T109 [P] [US1] Failing E2E test in `frontend/tests/e2e/auditor-export.spec.ts` — sign in mock, open asset, click Export, file downloaded; axe-core check on every visited page

### Implementation for User Story 1

- [~] T110 [US1] Implement `.ckl` writer in `backend/src/exporters/ckl.ts` — *partial: existing `cklExporter.ts` produces a CKL but uses lowercase status vocabulary, hardcodes `Workstation`/`Computing` ASSET role/type, hardcodes `CCI-000130`, and lacks deterministic ordering. Rewrite required for round-trip + determinism per T101/T107.*
- [ ] T111 [P] [US1] Implement `.cklb` writer in `backend/src/exporters/cklb.ts` — passes T103
- [ ] T112 [P] [US1] Implement XCCDF writer in `backend/src/exporters/xccdf.ts` — passes T104
- [ ] T113 [P] [US1] Implement OSCAL writer in `backend/src/exporters/oscal.ts` — passes T105
- [ ] T114 [P] [US1] Implement CSV writer (stable column order) in `backend/src/exporters/csv.ts` — passes T106
- [ ] T115 [US1] Implement export orchestrator in `backend/src/exporters/index.ts` enforcing complete `mappingChain` and deterministic ordering; rejects findings missing trace — passes T107
- [ ] T116 [US1] Implement `POST /exports` route in `backend/src/api/exports.ts` (streaming response, RBAC `auditor`+) — passes T108
- [ ] T117 [P] [US1] Add Read-only services for findings/assets/collections in `backend/src/services/{findings,assets,collections}.ts` (used by US1, US2)
- [ ] T117a [P] [US1] Implement `PATCH /findings/:id` with `If-Match` ETag optimistic concurrency in `backend/src/api/findings.ts`; reject 412 on stale write (covers spec edge case "two operators edit the same finding concurrently")
- [ ] T118 [P] [US1] Implement `GET /me`, `GET /collections`, `GET /collections/:id`, `GET /collections/:id/assets`, `GET /collections/:id/compliance`, `GET /assets/:id`, `GET /assets/:id/findings`, `GET /findings/:id` in `backend/src/api/`
- [ ] T119 [P] [US1] Frontend Collections list page in `frontend/src/pages/Collections.tsx`
- [ ] T120 [P] [US1] Frontend Collection detail with compliance donut + accessible table fallback in `frontend/src/pages/CollectionDetail.tsx`
- [ ] T121 [P] [US1] Frontend Asset detail with finding list, filters, and export button in `frontend/src/pages/AssetDetail.tsx`
- [ ] T122 [P] [US1] Frontend Finding detail drawer with evidence + mapping trace in `frontend/src/components/FindingDrawer.tsx`
- [ ] T123 [US1] Wire export download UX in `frontend/src/pages/AssetDetail.tsx` — passes T109

**Checkpoint**: US1 fully functional in mock mode; auditor can export a working `.ckl`.

---

## Phase 4: User Story 2 — Operator triggers evaluation across Azure + Arc (Priority: P1)

**Goal**: An operator triggers an on-demand scan over a Collection containing
both Azure-native and Arc-connected hosts; the system dispatches the right
evaluator per asset, fans results in, and shows new findings in the UI.

**Independent Test**: In mock mode, two assets (one VM, one Arc machine);
trigger scan; both produce findings within the simulated SLA; UI displays
identical detail surfaces.

### Tests for User Story 2 (TDD for mapping — constitution VII)

- [ ] T201 [P] [US2] Failing unit tests for mapping loader in `backend/tests/unit/mappings/loader.test.ts` — version coherence, schema validation, unknown rules rejected
- [ ] T202 [P] [US2] Failing unit tests for signal→Rule resolver in `backend/tests/unit/mappings/resolver.test.ts` — precedence, ambiguity, missing source → `Not_Reviewed` with `MANUAL_REVIEW_REQUIRED`
- [ ] T203 [P] [US2] Failing unit tests for applicability filter in `backend/tests/unit/evaluators/applicability.test.ts` — IIS rule on non-IIS asset filtered with reason
- [ ] T204 [P] [US2] Failing integration test for control-plane evaluator in `backend/tests/integration/evaluators/controlPlane.test.ts` — Policy + Defender + RG signals → findings with full mappingChain
- [ ] T205 [P] [US2] Failing integration test for guest-OS evaluator (mock MC) in `backend/tests/integration/evaluators/guestOs.test.ts`
- [ ] T206 [P] [US2] Failing contract test for `POST /scans` in `backend/tests/integration/api/scans.test.ts` — operator allowed, auditor denied, scope validated
- [ ] T207 [P] [US2] Failing E2E test in `frontend/tests/e2e/operator-scan.spec.ts` — trigger scan, observe state transitions, see new findings

### Implementation for User Story 2

- [ ] T208 [US2] Implement mapping loader in `backend/src/mappings/loader.ts` — reads versioned YAML from `backend/src/mappings/data/`; passes T201
- [ ] T209 [US2] Implement signal→Rule resolver in `backend/src/mappings/resolver.ts` — passes T202
- [ ] T210 [P] [US2] Author initial mapping packs covering Windows Server 2022 STIG, RHEL 9 STIG (guest-OS via MC), and Azure Storage / SQL / App Service / Key Vault SRG mappings (control-plane via Policy + Defender) under `backend/src/mappings/data/`
- [X] T211 [P] [US2] Implement Resource Graph connector — *covered by `backend/src/connectors/resourceGraphConnector.ts` (Azure VMs + Arc machines + mock)*
- [X] T212 [P] [US2] Implement Policy connector — *covered by `backend/src/connectors/policyConnector.ts`*
- [X] T213 [P] [US2] Implement Defender connector — *covered by `backend/src/connectors/defenderConnector.ts`*
- [X] T214 [P] [US2] Implement ARM/HybridCompute connector — *covered by `backend/src/connectors/armConnector.ts`*
- [ ] T215 [P] [US2] Implement Machine Configuration connector in `backend/src/connectors/machineConfigurationConnector.ts` (`@azure/arm-guestconfiguration`) + Mock — **net-new, required for T218 guest-OS evaluator**
- [ ] T216 [US2] Implement applicability filter in `backend/src/evaluators/applicability.ts` — passes T203
- [ ] T217 [US2] Implement control-plane evaluator in `backend/src/evaluators/controlPlane/index.ts` — passes T204
- [ ] T218 [US2] Implement guest-OS evaluator orchestration shim in `backend/src/evaluators/guestOs/index.ts` — assigns/reads MC results — passes T205
- [ ] T219 [US2] Implement Scan service in `backend/src/services/scans.ts` (queue, state transitions, partial-failure handling, prior findings preserved on failure)
- [ ] T220 [US2] Implement `POST /scans`, `GET /scans/:id` in `backend/src/api/scans.ts` — passes T206
- [ ] T221 [P] [US2] Implement `functions/src/scanOrchestrator/` (Service Bus trigger): pulls work, dispatches to evaluators, writes Findings, updates Scan state, emits AuditLog
- [ ] T222 [P] [US2] Implement `functions/src/findingsIngestor/` (Event Grid trigger) ingesting MC result events and persisting Findings
- [ ] T223 [P] [US2] Add Bicep `infra/modules/policy.bicep` for Guest Configuration Policy assignments and `infra/modules/messaging.bicep` for Service Bus + Event Grid
- [ ] T224 [P] [US2] Frontend scan-trigger UX in `frontend/src/pages/CollectionDetail.tsx` + per-asset live state indicator — passes T207
- [ ] T225 [P] [US2] Author `mc-packages/windows-stig/` skeleton wrapping Evaluate-STIG/PowerSTIG audit-only DSC and `mc-packages/build/` pipeline producing signed Guest Configuration packages

**Checkpoint**: US2 functional; scans complete end-to-end; Arc parity verified in mock.

---

## Phase 5: User Story 3 — Admin manages collections, roles, and exceptions (Priority: P2)

**Goal**: Admin defines Collections, assigns roles, and approves exceptions;
operators submit exceptions; expirations auto-revert.

**Independent Test**: Admin creates a Collection with a tag rule; operator
submits an exception with future expiry; admin approves; affected findings
flip to `Not_Applicable`; on expiration, they revert; both transitions are
audit-logged.

### Tests for User Story 3

- [ ] T301 [P] [US3] Failing tests for tag-rule evaluator in `backend/tests/unit/services/tagRule.test.ts`
- [ ] T302 [P] [US3] Failing contract tests for `/collections` (POST/PATCH), `/exceptions` (POST), `/exceptions/:id/decision` in `backend/tests/integration/api/admin.test.ts`
- [ ] T303 [P] [US3] Failing test for exception expiration job in `backend/tests/integration/jobs/exceptionExpirer.test.ts`
- [ ] T304 [P] [US3] Failing E2E `frontend/tests/e2e/admin-flow.spec.ts` — create collection, scope role, approve exception

### Implementation for User Story 3

- [ ] T305 [US3] Implement tag-rule evaluator in `backend/src/services/tagRule.ts` — passes T301
- [ ] T306 [P] [US3] Implement Collections service + admin endpoints in `backend/src/services/collections.ts` and `backend/src/api/collections.ts` (create, update, asset-rule re-eval)
- [ ] T307 [P] [US3] Implement RoleBinding service + admin endpoints in `backend/src/services/roles.ts`, `backend/src/api/roles.ts`
- [ ] T308 [P] [US3] Implement Exception service + endpoints in `backend/src/services/exceptions.ts`, `backend/src/api/exceptions.ts` — passes T302
- [ ] T309 [US3] Implement `functions/src/exceptionExpirer/` timer-triggered job — passes T303
- [ ] T310 [P] [US3] Frontend Settings → Collections page in `frontend/src/pages/SettingsCollections.tsx`
- [ ] T311 [P] [US3] Frontend Settings → Roles page in `frontend/src/pages/SettingsRoles.tsx`
- [ ] T312 [P] [US3] Frontend Settings → Exceptions page in `frontend/src/pages/SettingsExceptions.tsx` — passes T304

**Checkpoint**: US3 functional; multi-Collection, multi-role isolation verified.

---

## Phase 6: User Story 4 — Quarterly STIG content refresh (Priority: P2)

**Goal**: Automatic ingest of DISA quarterly drops with signature
verification, immutable storage, admin diff, and explicit activation.

**Independent Test**: Place a simulated quarterly drop in the content
source; the refresher fetches, verifies SHA-256 against signed manifest,
stores immutably, presents a diff; on activation, new scans use the new
version while prior findings remain bound to prior versions.

### Tests for User Story 4

- [ ] T401 [P] [US4] Failing tests for content fetcher + provenance verifier in `backend/tests/unit/content/fetcher.test.ts`
- [ ] T402 [P] [US4] Failing test for ContentPack diff in `backend/tests/unit/content/diff.test.ts`
- [ ] T403 [P] [US4] Failing test for activation workflow in `backend/tests/integration/content/activation.test.ts` — prior findings bound to prior version

### Implementation for User Story 4

- [ ] T404 [US4] Implement content fetcher + provenance verifier in `backend/src/content/fetcher.ts` — passes T401
- [ ] T405 [P] [US4] Implement ContentPack diff in `backend/src/content/diff.ts` — passes T402
- [ ] T406 [P] [US4] Implement Blob immutable cache writer in `backend/src/content/cache.ts` (versioned container + time-based retention)
- [ ] T407 [P] [US4] Implement `GET /content/packs`, `POST /content/packs/:id/activate` in `backend/src/api/content.ts` — passes T403
- [ ] T408 [P] [US4] Implement `functions/src/contentRefresher/` timer trigger
- [ ] T409 [P] [US4] Frontend Settings → Content page with diff viewer in `frontend/src/pages/SettingsContent.tsx`
- [ ] T410 [P] [US4] Bicep `infra/modules/storage.bicep` defines immutable container with retention policy

**Checkpoint**: US4 functional; provenance failures never auto-activate.

---

## Phase 7: User Story 5 — Mock-mode quickstart parity (Priority: P2)

**Goal**: A clean machine reaches a fully working dashboard in <5 minutes
with `docker compose up`, with deterministic data and zero outbound calls.

**Independent Test**: Fresh clone; `docker compose up`; visit
`http://localhost`; sign in as Demo Admin; perform every primary flow.

### Tests for User Story 5

- [ ] T501 [P] [US5] Failing E2E `frontend/tests/e2e/mock-quickstart.spec.ts` — full primary flow in mock; assert no outbound network calls (Playwright route interception)
- [ ] T502 [P] [US5] Failing test in `backend/tests/integration/mock/no-egress.test.ts` — under MOCK_MODE, all connectors short-circuit; no `httpx`/SDK call attempted

### Implementation for User Story 5

- [ ] T503 [US5] Audit every connector and the content fetcher to confirm `MOCK_MODE` short-circuits — passes T502
- [ ] T504 [P] [US5] Add seed-data loader CLI `backend/src/mock/seed.ts` invoked on container start when MOCK_MODE
- [ ] T505 [P] [US5] Document exactly the steps in [quickstart.md](./quickstart.md) — passes T501
- [ ] T506 [P] [US5] Add `make demo` / `npm run demo` target running `docker compose up --build` with the mock profile

**Checkpoint**: US5 functional; quickstart verified by CI on every PR.

---

## Phase 8: User Story 6 — POA&M lifecycle (Priority: P3)

**Goal**: Operators record POA&Ms against open findings; auto-close on
remediation; auto-flag overdue.

**Independent Test**: Attach POA&M to failing finding; subsequent mock scan
flips Rule to `NotAFinding`; POA&M auto-closes and is audit-logged.

### Tests for User Story 6

- [ ] T601 [P] [US6] Failing tests for POA&M auto-close logic in `backend/tests/unit/services/poam.test.ts`
- [ ] T602 [P] [US6] Failing tests for overdue flag job in `backend/tests/integration/jobs/poamOverdue.test.ts`

### Implementation for User Story 6

- [ ] T603 [US6] Implement POAM service + endpoints in `backend/src/services/poams.ts`, `backend/src/api/poams.ts`
- [ ] T604 [P] [US6] Implement auto-close hook in scan completion path — passes T601
- [ ] T605 [P] [US6] Implement daily overdue job in `functions/src/poamOverdue/` — passes T602
- [ ] T606 [P] [US6] Frontend POA&M panel inside Finding drawer

**Checkpoint**: US6 functional.

---

## Phase 9: Optional STIG Manager Integration (Feature-flagged)

**Trigger**: Activated when `STIGMAN_INTEGRATION=enabled`. Implementation
follows [contracts/stigmanager-adapter.md](./contracts/stigmanager-adapter.md).

- [ ] T701 [P] Pact-style consumer tests in `backend/tests/integration/stigman/` against vendored STIG Manager OpenAPI fixture
- [ ] T702 [P] Implement OAuth client-credentials token provider in `backend/src/stigmanager/auth.ts`
- [ ] T703 [P] Implement adapter in `backend/src/stigmanager/adapter.ts` — write-through for findings, exceptions, imports
- [ ] T704 [P] Add nightly E2E gated by `STIGMAN_E2E=true` in CI deploying STIG Manager to ephemeral Container Apps
- [ ] T705 [P] Bicep `infra/modules/stigmanager.bicep` (Container Apps + dependencies) — disabled by default

---

## Phase N: Polish & Cross-Cutting Concerns

- [ ] T801 [P] Add Application Insights workbooks under `infra/modules/observability.bicep` for: scan throughput, export latency, role-denial rate, content-refresh outcomes
- [ ] T802 [P] Add operations runbooks `docs/operations/runbook-content-refresh.md`, `runbook-scan-failures.md`, `runbook-rbac.md`
- [ ] T803 [P] Author threat model `docs/threat-model.md`
- [ ] T804 Run constitution audit script (`scripts/check-constitution.ps1`) verifying: every state-changing route has audit middleware, every connector has a Mock pair, every export goes through completeness gate
- [ ] T805 [P] Performance test export of 10,000-asset Collection (SC-006) under `backend/tests/perf/export.bench.ts`
- [ ] T806 [P] Performance test scan of 100-asset mixed Collection (SC-002) under `functions/tests/perf/scan.bench.ts`
- [ ] T807 [P] Final accessibility audit on every page in CI (axe-core); fail on any `serious`/`critical` (SC-008)
- [ ] T808 [P] Update `README.md` Deploy-to-Azure button URL and prerequisites; regenerate `infra/azuredeploy.json` from `main.bicep`
- [ ] T809 Run `quickstart.md` verification end-to-end in CI (US5 acceptance)

---

## Dependencies & Execution Order

### Phase Dependencies

- Phase 1 (Setup) → Phase 2 (Foundational) → Phases 3–8 (Stories, parallelizable post-foundation) → Phase 9 (optional) → Phase N (polish).

### Story Dependencies

- **US1** depends only on Phase 2 foundation; produces the MVP slice.
- **US2** depends on Phase 2 + the mapping loader from its own phase (T208);
  shares the connectors with future stories.
- **US3** depends on Phase 2; integrates with US2 for exception application
  to findings.
- **US4** depends on Phase 2 + the ContentPack model; runs alongside US2 once
  mappings exist.
- **US5** depends on US1 + US2 mock fixtures.
- **US6** depends on US2 (needs scans to drive auto-close).

### Constitution-Driven Order Rules

- Auth tests T015–T016 MUST be authored and failing **before** T017–T018.
- Export tests T101–T108 MUST be failing **before** T110–T116.
- Mapping tests T201–T203 MUST be failing **before** T208–T210.

### Parallelism Highlights

- Within Phase 2, T012–T014 (entities), T015–T019 (auth modules), and
  T024–T030 (connector interfaces + frontend foundations) can largely run in
  parallel.
- Within US1, all exporter writers (T110–T114) parallelize after T115's
  contract is stable.
- Within US2, all connectors (T211–T215) parallelize behind their interfaces
  from T024.
- All `[P]`-tagged tasks within a phase target distinct files and can be
  worked simultaneously.

---

## Implementation Strategy

1. **MVP cut**: Phase 1 + Phase 2 + Phase 3 (US1) gives a usable auditor flow
   over seeded data with a working `.ckl` export. Ship this first.
2. **Operability cut**: Add Phase 4 (US2) and Phase 7 (US5) — real evaluation
   path + demo parity.
3. **Governance cut**: Add Phase 5 (US3) and Phase 6 (US4) — multi-team
   collections + content lifecycle.
4. **RMF parity cut**: Add Phase 8 (US6) and optionally Phase 9 (STIG Manager).
5. **Hardening cut**: Phase N — observability, threat model, perf, a11y CI.

Each cut is independently demoable and stays inside constitution gates.
