# Implementation Plan: Azure STIG Dashboard

**Branch**: `001-azure-stig-dashboard` | **Date**: 2026-05-07 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-azure-stig-dashboard/spec.md`

## Summary

Deliver an Entra-protected web app, hosted in the customer's Azure tenant, that
discovers Azure + Azure Arc estate, evaluates each asset against applicable
DISA STIGs/SRGs, normalizes results into a unified findings model with full
traceability (signal → Vuln → Rule → CCI → NIST control + benchmark SHA-256),
and produces auditor-ready exports (`.ckl`, `.cklb`, XCCDF, OSCAL, CSV).
Build on the existing scaffold (React + Fluent UI + Vite frontend; Node 20 +
Express + TypeORM backend; PostgreSQL Flexible Server; Bicep IaC; Application
Insights; Docker Compose for mock mode). Add Azure Machine Configuration
custom packages (Evaluate-STIG, PowerSTIG) for guest-OS evaluation, Functions
+ Service Bus for scan orchestration, Blob-backed immutable content cache for
DISA quarterly drops, and an optional STIG Manager integration via its
OpenAPI 3.0.1 REST API.

## Technical Context

**Language/Version**: TypeScript 5.4 (strict). Node.js 20 LTS for backend +
Functions. PowerShell 7 for Machine Configuration packages. Bicep latest.

**Primary Dependencies**:
- Frontend: React 18, Fluent UI v9, Vite 5, MSAL.js v3, @tanstack/react-query,
  Recharts (with table-equivalent fallback), axe-core in CI.
- Backend: Express, TypeORM, `@azure/identity` (DefaultAzureCredential with
  ManagedIdentityCredential in cloud), `@azure/arm-resourcegraph`,
  `@azure/arm-policy`, `@azure/arm-policyinsights`, `@azure/arm-security`,
  `@azure/arm-resources`, `@azure/arm-hybridcompute`, `@azure/arm-appcontainers`,
  `@azure/arm-machinelearningservices` (for MC types), `@azure/arm-guestconfiguration`,
  `@azure/storage-blob`, `@azure/keyvault-secrets`, `@azure/service-bus`,
  `passport-azure-ad` (or `jose` + jwks-rsa), `xml2js`, `fast-xml-parser`,
  `pino`, `applicationinsights`.
- Functions (TypeScript): `@azure/functions` v4 programming model for scan
  orchestrator, content refresher, exception expirer.
- Testing: Vitest (unit), Supertest (API), Playwright (E2E + axe-core a11y),
  Pact-style contract tests for the STIG Manager adapter.

**Storage**:
- PostgreSQL 16 Flexible Server (canonical) — relational with JSONB for
  evidence blobs.
- Azure Blob Storage — content cache (immutable container with versioned blob
  storage and legal-hold/time-based retention) for DISA artifacts; raw scan
  artifacts (.ckl/.cklb/XCCDF) for evidence; export staging.
- Azure Key Vault — secrets/JWT signing keys/STIG Manager API key (when
  enabled).
- Log Analytics Workspace — telemetry + audit log mirror.

**Testing**: Vitest + Supertest for backend, Playwright + axe-core for
frontend E2E and a11y, Bicep `what-if` in CI, CodeQL, `npm audit`.

**Target Platform**: Azure App Service Linux (containerized) for backend;
Azure App Service Linux for frontend (nginx) OR Static Web Apps; Azure
Functions Flex Consumption for orchestration; Azure Container Apps as a
deploy variant for STIG Manager sidecar.

**Project Type**: Web application (frontend + backend monorepo) — already
present in repo.

**Performance Goals** (derived from SCs):
- Export `.ckl` for one asset in <15s (SC-001).
- Evaluate 100-asset Collection end-to-end in <30 minutes p95 (SC-002).
- Stream a 10,000-asset export in <5 minutes p95 with bounded memory (SC-006).
- Audit-log visible in UI within 5s of action (SC-007).
- Role revocation enforced within 60s (SC-009).

**Constraints**:
- Production deployments MUST disable public network access on PostgreSQL,
  Storage, and Key Vault (Private Endpoints inside the app's VNet).
- No client secrets in source; managed identity only.
- TLS 1.2 minimum; HSTS enabled.
- Mock-mode parity: every connector and exporter MUST run with zero outbound
  calls when `MOCK_MODE=true`.
- Deterministic exports: same inputs → byte-identical output (SC-010).

**Scale/Scope (MVP)**:
- 10,000 assets per tenant, 200 Collections, 50 concurrent users.
- ~250 STIG/SRG benchmark versions cached at any time.
- ~2M findings retained at MVP cap; partitioned by month.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | How this plan satisfies it | Status |
|-----------|---------------------------|--------|
| I. Zero-Trust Auth | MSAL.js SPA + Express JWT validation against tenant JWKS; managed identity for all Azure calls; no client secrets | ✅ |
| II. Immutable Audit | `AuditLog` table is append-only at the application layer; mirrored to Log Analytics within 60s via diagnostic settings; deletion path absent in code | ✅ |
| III. Deterministic Content Versioning | `ContentPack` entity captures Title/Version/Release/Date/SHA-256; immutable Blob container with time-based retention; findings reference `BenchmarkVersionId` (FK) not "latest" | ✅ |
| IV. Full Traceability | `Mapping` records source → Rule; `Finding` carries `RuleId` (→ Vuln_Num, CCI[], NIST[]) and `BenchmarkVersionId`; mapping coverage check enforced at export time | ✅ |
| V. Mock-Mode Parity | Connector interface with `Real*` and `Mock*` implementations; `MOCK_MODE=true` toggles binding; deterministic seeded data fixtures committed to repo; CI runs full E2E in mock mode | ✅ |
| VI. IaC Only | Bicep canonical, ARM JSON generated from Bicep for Deploy-to-Azure button; RBAC, Policy, Machine Configuration assignments all in Bicep; portal changes prohibited by policy | ✅ |
| VII. Test-First (Mapping/Export/Auth) | These three modules are TDD with fixtures from DISA STIG Viewer round-trip; CI includes round-trip test gate | ✅ |
| VIII. WCAG 2.1 AA | Fluent UI base, axe-core in CI, keyboard nav E2E tests, status uses icon+text+color, table-equivalent for every chart | ✅ |
| IX. Least Privilege | App MI: `Reader` + `Security Reader` + `Azure Connected Machine Resource Reader` + `Log Analytics Reader` + `Key Vault Secrets User`. Separate "Scan Orchestrator" identity with narrow `Guest Configuration Resource Contributor` scope on a single Resource Group used for MC assignments | ✅ |

No constitution violations identified. **Complexity Tracking** section omitted.

## Project Structure

### Documentation (this feature)

```text
specs/001-azure-stig-dashboard/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── openapi.yaml          # Generated/maintained alongside backend/openapi.yaml
│   └── stigmanager-adapter.md
├── checklists/
│   └── requirements.md
└── tasks.md                  # Created by /speckit.tasks
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── api/                  # Express routers (REST endpoints; OpenAPI source of truth)
│   │   ├── auth.ts
│   │   ├── collections.ts
│   │   ├── assets.ts
│   │   ├── scans.ts
│   │   ├── findings.ts
│   │   ├── exceptions.ts
│   │   ├── exports.ts
│   │   ├── imports.ts
│   │   ├── content.ts
│   │   └── audit.ts
│   ├── auth/                 # JWT validation, RBAC, audit middleware
│   ├── connectors/           # Azure ingestion sources
│   │   ├── resourceGraph.ts
│   │   ├── policy.ts
│   │   ├── defender.ts
│   │   ├── arm.ts
│   │   ├── machineConfiguration.ts
│   │   └── arc.ts
│   ├── evaluators/           # Per-platform evaluation orchestration
│   │   ├── guestOs/          # Windows/Linux via MC packages
│   │   ├── controlPlane/     # PaaS via Policy/Defender/RG
│   │   └── importBased/      # External .ckl/.cklb/XCCDF
│   ├── mappings/             # Versioned signal→Rule mapping JSON/YAML + loader
│   ├── exporters/            # ckl, cklb, xccdf, oscal, csv
│   ├── importers/            # ckl, cklb, xccdf
│   ├── content/              # public.cyber.mil sync, provenance verification
│   ├── stigmanager/          # Optional adapter (feature-flagged)
│   ├── entities/             # TypeORM entities
│   ├── migrations/           # TypeORM migrations
│   ├── mock/                 # Deterministic seed data + mock connectors
│   ├── telemetry/            # Pino + App Insights
│   └── server.ts
├── tests/
│   ├── unit/
│   ├── integration/          # Supertest against in-memory or Testcontainers Postgres
│   └── fixtures/             # DISA STIG Viewer round-trip fixtures
├── openapi.yaml
└── Dockerfile

functions/                    # NEW — orchestration runtime
├── src/
│   ├── scanOrchestrator/     # Service Bus triggered; assigns MC, polls results
│   ├── contentRefresher/     # Timer triggered; quarterly DISA sync
│   ├── exceptionExpirer/     # Timer triggered; reverts expired exceptions
│   └── findingsIngestor/     # Event Grid triggered; ingests MC results
├── host.json
└── package.json

frontend/
├── src/
│   ├── pages/                # Overview, Collections, Assets, Asset detail, Findings, Audit, Settings
│   ├── components/
│   ├── auth/                 # MSAL config + role hooks
│   ├── api/                  # Generated client from openapi.yaml
│   ├── mock/                 # Mock-mode bypass
│   └── main.tsx
├── tests/
│   └── e2e/                  # Playwright + axe-core
└── Dockerfile

mc-packages/                  # NEW — Machine Configuration custom packages
├── windows-stig/             # Wraps Evaluate-STIG / PowerSTIG audit DSC
├── linux-stig/               # Wraps Evaluate-STIG Linux audit
└── build/                    # PSDscResources/Guest Configuration build pipeline

infra/
├── main.bicep                # Existing — extend with Functions, Service Bus, Event Grid, MC assignments, Private Endpoints
├── modules/
│   ├── network.bicep
│   ├── identity.bicep
│   ├── data.bicep            # Postgres, Storage, Key Vault
│   ├── app.bicep             # App Service plan + apps + Functions
│   ├── observability.bicep   # App Insights + Log Analytics + Diagnostic Settings
│   ├── policy.bicep          # Guest Configuration assignments
│   └── stigmanager.bicep     # Optional Container Apps deployment
├── azuredeploy.json          # Generated from main.bicep
└── helm/                     # Optional STIG Manager Helm values

docs/
├── architecture.md           # Existing — extend with Arc + MC + Functions topology
├── data-flow.md              # Existing — extend
├── example-mapping.json      # Existing — keep as reference
├── sample.ckl                # Existing — keep as round-trip baseline
├── operations/
│   ├── runbook-content-refresh.md
│   ├── runbook-scan-failures.md
│   └── runbook-rbac.md
└── threat-model.md

e2e/                          # Existing top-level Playwright config
.github/
├── workflows/
│   ├── ci.yml                # lint, typecheck, unit, integration, e2e mock, axe, codeql, bicep what-if
│   └── deploy.yml            # azd up / Bicep deploy on tag
├── prompts/                  # Spec Kit slash-command companions (already in place)
└── agents/                   # Spec Kit agent files (already in place)
```

**Structure Decision**: Adopt the existing **web-application monorepo** layout
already present in the repo and *extend* it with three new top-level
directories: `functions/` (orchestration), `mc-packages/` (Machine
Configuration audit packages), and `infra/modules/` (modular Bicep). Frontend
and backend keep their current locations and Dockerfiles.

## Phase 0 Outputs

See [research.md](./research.md). All NEEDS CLARIFICATION items resolved.

## Phase 1 Outputs

- [data-model.md](./data-model.md) — entity model and state machines.
- [contracts/openapi.yaml](./contracts/openapi.yaml) — REST contract.
- [contracts/stigmanager-adapter.md](./contracts/stigmanager-adapter.md) —
  adapter spec for optional STIG Manager integration.
- [quickstart.md](./quickstart.md) — mock-mode quickstart and developer setup.
- Agent context updated via `update-agent-context.ps1 -AgentType copilot`.

## Re-check: Constitution Check After Phase 1

All gates remain green. The Phase 1 design preserves the
mock-mode parity contract (every new connector includes a mock implementation
in the same PR), the audit-log coverage requirement (every state-changing
endpoint passes through audit middleware), and the deterministic-export
requirement (export endpoints take an explicit `ScanId` rather than "latest"
to keep results reproducible).
