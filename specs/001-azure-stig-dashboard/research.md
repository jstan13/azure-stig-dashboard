# Phase 0 Research — Azure STIG Dashboard

This document records the design decisions taken before any implementation.
Each entry follows the format: **Decision / Rationale / Alternatives considered**.

## R-01 — Guest-OS evaluation engine

**Decision**: Use **Azure Machine Configuration** (formerly Guest Configuration)
to ship two custom audit packages — `windows-stig` (wrapping Evaluate-STIG and
PowerSTIG audit composite resources) and `linux-stig` (wrapping Evaluate-STIG
Linux). Assign packages via Azure Policy. Consume results via the
Guest Configuration ARM data plane and Resource Graph.

**Rationale**:
- Works identically on Azure-native VMs and Azure Arc-enabled servers
  (`Microsoft.HybridCompute/machines`), satisfying FR-007 and User Story 2.
- Uses an agent that's already deployed (Arc agent or VM extension) — no extra
  endpoint footprint.
- Results land in Azure Resource Graph and Log Analytics with structured
  schemas — clean ingestion path for the orchestrator.
- Evaluate-STIG and PowerSTIG are both DoD-recognized and produce CKL-shaped
  output; we keep parity with the rest of the ecosystem.

**Alternatives considered**:
- *Run Command + remote PowerShell on demand* — works, but no scheduling, no
  Arc parity for non-PowerShell hosts, no result archive. Fallback path only.
- *Self-hosted scanner agents* — adds an agent we don't need; rejected.
- *SCAP Compliance Checker (SCC) over WinRM/SSH* — desktop tool, no Azure
  control plane integration; rejected for primary use.

## R-02 — Control-plane (PaaS) evaluation

**Decision**: Map applicable SRG/STIG Rules for Azure PaaS surfaces (App
Service, SQL, Storage, Key Vault, AKS, Defender posture) to a combination of
**Azure Policy compliance state**, **Defender for Cloud assessments**, and
**Resource Graph queries**. The mapping layer (`backend/src/mappings/`)
declares per-Rule which signal sources can satisfy it, and the
Control-Plane Evaluator composes them.

**Rationale**:
- These data planes are already authoritative for the relevant configurations
  and are read-only (matches Principle IX — Least Privilege).
- Quarterly mapping updates are reviewable and version-controllable.
- Findings retain full traceability per FR-009.

**Alternatives considered**:
- *Direct ARM property reads only* — fragile and verbose; rejected.
- *Defender-only* — Defender doesn't cover every Rule; rejected.

## R-03 — Orchestration runtime

**Decision**: Add **Azure Functions (TypeScript v4 programming model, Flex
Consumption plan)** with **Service Bus** for scan dispatch and **Event Grid**
for result fan-in. Functions are deployed under the same `infra/` Bicep.

**Rationale**:
- On-demand and scheduled scans both need durable retry, backpressure, and
  result fan-in — App Service is the wrong tool, Functions are right.
- Flex Consumption gives VNet integration (required for Private Endpoint
  topology) without paying for always-on.
- Same TypeScript codebase patterns as the backend; shared types via a small
  internal `@stigdash/shared` package.

**Alternatives considered**:
- *Azure Container Apps Jobs* — viable; deferred as an alternate deploy
  variant for customers who don't want Functions.
- *Hangfire / BullMQ inside the App Service* — couples scan orchestration to
  request-serving lifecycle; rejected.

## R-04 — Database

**Decision**: **Azure Database for PostgreSQL Flexible Server 16** with
private networking only in production. JSONB columns for evidence and raw
signal blobs; relational columns for everything queryable.

**Rationale**:
- Existing scaffold already uses TypeORM + Postgres.
- JSONB handles polymorphic evidence shapes without separate document store.
- Flexible Server supports VNet integration, geo-redundant backups, and the
  pricing tier the constitution and SCs imply.

**Alternatives considered**:
- *Cosmos DB* — overkill, and harder to do the relational joins this domain
  requires.
- *Azure SQL* — fine but TypeORM/Postgres is the existing tooling.

## R-05 — STIG content cache and provenance

**Decision**: Sync DISA quarterly drops from public.cyber.mil into an
**immutable Blob Storage container** with versioning enabled and a
time-based retention policy of 7 years. A signed manifest is fetched
alongside content; the `content/` module verifies SHA-256 before any artifact
is admitted to the cache. A separate `ContentPack` table records ingested
versions with their hashes.

**Rationale**:
- Constitution Principle III requires deterministic versioning and immutable
  storage.
- Findings reference `BenchmarkVersionId` from the cache, never "latest".
- Immutable Blob policies protect against accidental rewrite even by admins.

**Alternatives considered**:
- *Filesystem cache on the App Service* — non-immutable, lost on swap.
- *Embed STIG XML in the container image* — couples deploy cadence to STIG
  release cadence; rejected.

## R-06 — Authentication & authorization

**Decision**: **Microsoft Entra ID** as the only IdP. Frontend uses MSAL.js
v3 (auth code + PKCE for SPA). Backend validates JWTs with `jose` against
the tenant's JWKS, caching keys in-memory with a 1-hour TTL. Roles are
expressed as **app roles** (`admin`, `operator`, `auditor`) on the API app
registration and **Collection-scoped role bindings** stored in the database
(a user can be `auditor` on Collection A and `operator` on Collection B).
Backend RBAC middleware combines: (a) app-role from token, (b)
Collection-scoped binding from DB, (c) explicit deny rules. Every check
emits an `AuthDecision` audit record on deny.

**Rationale**:
- Matches Principle I and FR-001..FR-003.
- App roles + DB-scoped bindings is the standard pattern for multi-tenant
  scoping and avoids encoding Collection IDs into the token.

**Alternatives considered**:
- *Azure RBAC scopes only* — doesn't model "auditor on Collection A only"
  cleanly.
- *Open Policy Agent sidecar* — overkill at MVP scale.

## R-07 — Export format fidelity

**Decision**: Implement `.ckl` and `.cklb` writers that match the schemas
DISA STIG Viewer accepts. Build round-trip test fixtures from real STIG
Viewer output (export → save in STIG Viewer → re-import → assert field
parity). XCCDF and OSCAL exports use the canonical NIST OSCAL schema and the
SCAP 1.3 XCCDF schema. CSV exports use a stable column order.

**Rationale**:
- FR-013 mandates round-trip preservation.
- SC-010 mandates byte-identical re-runs (achieved by sorting all collections
  and stable timestamp omission rules).

**Alternatives considered**:
- *Use STIG Manager's existing exporters via an HTTP call* — viable when STIG
  Manager integration is enabled, but cannot be the only path; built-in
  exporter required.

## R-08 — Optional STIG Manager integration

**Decision**: Treat STIG Manager as an **optional system of record**, gated
behind a `STIGMAN_INTEGRATION=enabled` flag. When enabled, the backend's
`stigmanager/` adapter forwards finding writes and import events to STIG
Manager via its OpenAPI 3.0.1 REST API; when disabled, the local Postgres is
the system of record. Both modes share the same UI and exporter.

**Rationale**:
- DoD customers may already operate STIG Manager and prefer to keep it as
  authoritative; this product becomes the Azure-aware ingestion + UI layer.
- Customers without STIG Manager get a self-contained product.

**Alternatives considered**:
- *Always require STIG Manager* — rejected; raises adoption cost.
- *Embed STIG Manager directly* — its license/runtime model differs; keep
  loose coupling.

## R-09 — Mock mode design

**Decision**: All connectors implement an interface; binding is selected at
startup from `MOCK_MODE`. Mock implementations read deterministic JSON
fixtures committed under `backend/src/mock/fixtures/` and return data with
fixed timestamps and stable ordering. The frontend mock mode auto-signs in a
"Demo Admin" user via a stub MSAL provider. CI runs the full Playwright E2E
in mock mode on every PR.

**Rationale**:
- Constitution Principle V; SC-004; SC-010 (deterministic).
- Demoability without an Azure tenant is a major adoption driver.

## R-10 — Observability

**Decision**: Pino logs in JSON, shipped to Application Insights via
`applicationinsights` SDK. Every request gets a correlation ID; the same ID
flows through Service Bus messages and into MC orchestration logs. Diagnostic
Settings forward App Insights, App Service, Functions, Postgres, and Storage
logs to a central Log Analytics workspace. Dashboards in Azure Workbooks for
operations.

**Rationale**:
- FR-020; SC-007.
- Single-pane observability across the orchestration chain is required for
  RCA when scans fail (User Story 2 acceptance scenario 3).

## R-11 — Frontend stack

**Decision**: Keep React 18 + Vite 5 + Fluent UI v9 (already in repo). Add
**@tanstack/react-query** for server state, **react-router** v6 for routing,
and **axe-core** in CI. Use `Recharts` for charts but always render an
accessible `<table>` equivalent in a collapsible "Data view" panel for every
chart (satisfies FR-018 / Principle VIII).

**Rationale**:
- Existing investment; no rewrite warranted.
- Fluent UI gives a Microsoft-look that is appropriate for the audience and
  is a11y-tested upstream.

## R-12 — IaC layout and deploy strategy

**Decision**: Bicep modular under `infra/modules/`. `azd` (Azure Developer
CLI) is the supported deploy path for developers; the **Deploy to Azure**
button uses an `azuredeploy.json` generated from `main.bicep` via
`bicep build`. CI runs `bicep build`, `az deployment sub what-if` against a
pre-prod subscription, posts the diff to PRs, and deploys on tag.

**Rationale**:
- Principle VI — IaC only.
- `azd` accelerates dev loop while ARM JSON keeps the one-click button
  working for the README.

## R-13 — Severity, status, and applicability vocabulary

**Decision**: Use DISA's vocabulary verbatim. Statuses: `Open`,
`NotAFinding`, `Not_Applicable`, `Not_Reviewed`. Severities: `CAT I`,
`CAT II`, `CAT III` (with override field). Applicability decisions are
recorded as either `Applicable`, `NotApplicable_TechAreaMissing`, or
`NotApplicable_Excepted`.

**Rationale**: Auditors expect this vocabulary in exports; using anything
else creates round-trip noise.

## R-14 — Time and clock

**Decision**: All timestamps stored UTC, ISO 8601 with `Z`. Display in
viewer's local timezone with UTC tooltip. Audit records include both
`occurredAt` (event time) and `recordedAt` (DB insert time); when they
disagree by more than 5 seconds, raise an `OBSERVABILITY_LATENCY` alert.

**Rationale**: Auditors compare timelines across systems; consistent UTC is
non-negotiable.

## R-15 — Identifier strategy

**Decision**: ULIDs for all entity primary keys (lexicographic, time-prefixed,
URL-safe). Azure resource IDs are stored as a separate canonical field.
Vuln_Num and Rule_ID from DISA are stored as-is and unique within a
`BenchmarkVersion`.

**Rationale**: ULIDs keep audit log ordering meaningful and avoid the
predictability problems of sequential integers in URLs.

---

All NEEDS CLARIFICATION items from the plan template are resolved. Phase 0 is
complete.
