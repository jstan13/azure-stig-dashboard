<!--
SYNC IMPACT REPORT
Version change: (none) → 1.0.0
Type: Initial ratification (MAJOR baseline)
Modified principles: n/a (initial)
Added sections:
  - Core Principles (I–IX)
  - Security & Compliance Requirements
  - Development Workflow & Quality Gates
  - Governance
Removed sections: none
Templates requiring updates:
  - .specify/templates/plan-template.md      ⚠ pending — add explicit Constitution Check items
  - .specify/templates/spec-template.md      ⚠ pending — add STIG traceability + accessibility sections
  - .specify/templates/tasks-template.md     ⚠ pending — add audit/observability/IaC task categories
  - .github/agents/speckit.*.agent.md        ⚠ pending — fix `.specify.specify/` path typo on next regen
Follow-up TODOs: none
-->

# Azure STIG Dashboard Constitution

The Azure STIG Dashboard is a federally-aligned compliance application. These
principles are non-negotiable and apply to every change in this repository,
whether to product code, infrastructure, content packs, or documentation.

## Core Principles

### I. Zero-Trust Authentication & Authorization (NON-NEGOTIABLE)
All human and machine access MUST be brokered by Microsoft Entra ID. The
frontend MUST authenticate via MSAL.js (authorization code + PKCE, SPA flow).
The backend MUST validate JWTs against the tenant's published JWKS and enforce
role-based access (`admin`, `operator`, `auditor`) via app roles. No anonymous
endpoints other than `/healthz` and `/readyz`. All Azure-side access from the
app MUST use a system-assigned managed identity — no client secrets, no shared
keys, no SAS tokens checked into source. Mock mode is the only exception and
MUST be feature-flagged off by default in any deployed environment.
*Rationale:* The product is an audit instrument; weak auth invalidates every
finding it produces.

### II. Immutable, Tamper-Evident Audit Trail (NON-NEGOTIABLE)
Every state change — finding edits, status overrides, exception
create/extend/expire, scan trigger, export generation, role assignment — MUST
write an `AuditLog` record containing actor, role, action, before/after, source
IP, correlation ID, and UTC timestamp. Audit records MUST be append-only at the
application layer and MUST be mirrored to Log Analytics within 60 seconds.
Deletion of audit rows is forbidden in code paths; retention is enforced via
storage policy, not application logic.
*Rationale:* Auditors must be able to reconstruct who changed what, when, and
why, without trusting the application.

### III. Deterministic STIG Content Versioning
Every finding MUST be bound to a specific STIG benchmark version (Title,
Version, Release, Release Date, SHA-256 of the source XCCDF/CKL artifact). When
DISA publishes new content, prior findings MUST NOT be silently rewritten;
they MUST be carried forward against the prior version until re-evaluation
produces a result against the new version. Content packs are stored in Blob
Storage with versioned containers and immutable retention.
*Rationale:* STIG benchmarks evolve; compliance evidence must be reproducible
months later for ATO packages.

### IV. Traceable Mapping From Signal → Vuln → Rule → CCI → Control
Every Azure-side signal (Resource Graph property, Policy state, Defender
assessment, Machine Configuration audit result, custom check) MUST map to a
specific STIG `Vuln_Num` and `Rule_ID`, which in turn carry CCI references and
NIST 800-53 control mappings. Mappings live in versioned, reviewable JSON/YAML
under `backend/src/mappings/` and are loaded at startup; they are NOT computed
ad-hoc. A finding without a complete mapping chain MUST be flagged as
`Not_Reviewed` rather than silently dropped or marked compliant.
*Rationale:* Auditors trace findings up the control hierarchy; broken chains
break the audit.

### V. Mock-Mode Parity
Every connector, exporter, and UI surface MUST function with `MOCK_MODE=true`
using deterministic sample data committed to the repo. CI MUST run the full
test suite in mock mode on every PR. A feature is not "done" until it works in
both real and mock modes with the same UX and the same data shape.
*Rationale:* Contributors and demoers must be able to run and reason about the
app without a tenant; reviewers must be able to verify behavior without
provisioning Azure.

### VI. Infrastructure as Code Only
All Azure resources MUST be defined in Bicep (canonical) with an
`azuredeploy.json` ARM artifact generated from it for the Deploy-to-Azure
button. No portal-only configuration. RBAC role assignments, Policy
assignments, Machine Configuration assignments, and Key Vault access policies
are part of the IaC. Manual changes to a deployed environment are allowed only
for incident response and MUST be reconciled back into Bicep within the same
sprint.
*Rationale:* The product itself audits drift; the product's own infrastructure
must not drift.

### VII. Test-First for Mapping, Export, and Auth Logic (NON-NEGOTIABLE)
Three areas MUST follow strict TDD: (a) signal→STIG mapping, (b) `.ckl` /
`.cklb` / XCCDF / OSCAL export serialization, (c) JWT validation and RBAC
checks. For these modules, a failing test MUST exist and be reviewed before
implementation. Other modules SHOULD follow TDD but are not blocked on it.
Export modules MUST round-trip against fixtures published by DISA STIG Viewer
(open the export in STIG Viewer, save, re-parse — fields preserved).
*Rationale:* Silent bugs in these three areas produce wrong audit evidence,
which is worse than no evidence.

### VIII. Accessibility WCAG 2.1 AA
The dashboard UI MUST meet WCAG 2.1 AA. Color is never the sole indicator of
status; every chart and badge has a text and ARIA equivalent; keyboard
navigation reaches every interactive element; contrast ratios are verified in
CI via axe-core. Screenshots in docs MUST include the data-table fallback view.
*Rationale:* Section 508 applies to federal users of this tool; accessibility
is a contract requirement, not a nice-to-have.

### IX. Least-Privilege Operations
The app's managed identity is granted the minimum roles required: `Reader` and
`Security Reader` at scan scopes; `Azure Connected Machine Resource Reader`
where Arc is in play; `Log Analytics Reader` for query of MC results;
`Key Vault Secrets User` only on the app's own vault. The app MUST NOT request
or accept `Contributor` or `Owner`. Scan-trigger operations that require write
(e.g., assigning a Machine Configuration policy) MUST be performed by a
separate, explicitly-scoped identity reviewed in IaC.
*Rationale:* A read-only auditor that can write is a privileged service; we
reject that posture by design.

## Security & Compliance Requirements

- **Data classification:** Findings are CUI-adjacent. Production deployments
  MUST disable public network access on PostgreSQL, Storage, and Key Vault,
  using Private Endpoints inside the app's VNet.
- **Secrets:** No secrets in source, no secrets in App Service application
  settings as plain text. All secrets resolved via Key Vault references using
  managed identity.
- **TLS:** TLS 1.2 minimum; HSTS enabled; HTTP redirected to HTTPS at the
  ingress.
- **Dependencies:** `npm audit --audit-level=high` and a SAST scan (CodeQL)
  MUST pass on every PR. High/critical findings block merge.
- **Supply chain:** Container images are built from pinned base images and
  scanned (Trivy or Defender for Containers) before deploy.
- **STIG content provenance:** Content downloaders MUST verify the SHA-256 of
  retrieved artifacts against a signed manifest before ingest.

## Development Workflow & Quality Gates

- **Branching:** Trunk-based. `main` is always deployable. Feature branches
  short-lived; merged via squash with a Conventional Commit message.
- **Required PR checks:** lint (ESLint + Prettier strict), `tsc --noEmit` with
  `strict: true`, unit tests, mock-mode E2E (Playwright), Bicep `what-if`
  diff posted as a PR comment, axe-core a11y check, CodeQL.
- **OpenAPI:** The backend's `openapi.yaml` is the contract. Any route change
  MUST update it; CI fails if generated types drift.
- **Definition of Done:** code + tests + OpenAPI + docs + IaC + audit-log
  coverage + mock-mode parity + a11y check pass.
- **Reviews:** At least one reviewer; security-sensitive areas
  (auth, export, mappings, IaC, RBAC) require a CODEOWNERS-designated
  reviewer.

## Governance

This Constitution supersedes ad-hoc conventions. Amendments require: (a) a PR
modifying `.specify/memory/constitution.md`, (b) a Sync Impact Report at the
top of the file, (c) corresponding updates to `plan-template.md`,
`spec-template.md`, and `tasks-template.md` where principles change task
categories or gates, (d) approval from a CODEOWNER.

Versioning of this document follows SemVer:
- **MAJOR** — a principle is removed or its meaning materially reversed.
- **MINOR** — a new principle or section is added, or a principle is
  materially expanded.
- **PATCH** — clarifications, wording, or non-semantic refinements.

Compliance is verified during PR review and during quarterly self-audits run
against the same dashboard this product builds.

**Version**: 1.0.0 | **Ratified**: 2026-05-07 | **Last Amended**: 2026-05-07
