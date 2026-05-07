# Feature Specification: Azure STIG Dashboard

**Feature Branch**: `001-azure-stig-dashboard`
**Created**: 2026-05-07
**Status**: Draft
**Input**: User description: "Azure STIG Dashboard MVP — an Entra-protected web app hosted in our Azure tenant that auto-discovers Azure + Azure Arc estate, evaluates each asset against applicable DISA STIGs/SRGs, normalizes results into a unified findings model, and produces STIG Viewer-compatible exports (.ckl, .cklb), XCCDF, OSCAL, and CSV. Supports collections/ATO boundaries, role-based review (admin/operator/auditor), exceptions with expiration, scheduled and on-demand scans, quarterly auto-refresh of STIG content from public.cyber.mil, and optional integration with NUWCDIVNPT STIG Manager. Mock-mode parity required."

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Auditor reviews compliance posture and exports a CKL for an ATO package (Priority: P1)

An auditor preparing an ATO submission opens the dashboard, selects a Collection
representing the system boundary, sees current compliance status across every
asset in that boundary, drills into a specific machine to review individual
STIG findings with evidence, and exports a STIG Viewer–compatible `.ckl` (or
`.cklb`) file ready to attach to the ATO package.

**Why this priority**: This is the single workflow that justifies the product's
existence. Without a trustworthy export usable in DISA STIG Viewer, every other
feature is decoration.

**Independent Test**: Load mock-mode data, sign in as an auditor, navigate to a
Collection, open a machine, click Export. The resulting file opens in DISA STIG
Viewer with all expected Vuln IDs, statuses, finding details, and host metadata
populated; round-tripping the file (open → save → re-open in our app) preserves
fields.

**Acceptance Scenarios**:

1. **Given** an auditor is signed in and a Collection contains at least one
   evaluated asset, **When** they request an export for that asset, **Then**
   the system returns a `.ckl` file whose `ASSET` block contains the asset's
   hostname, FQDN, IP, MAC, role, and tech area, and whose `iSTIG` blocks
   contain one `VULN` per applicable Rule with `STATUS`, `FINDING_DETAILS`,
   `COMMENTS`, and `SEVERITY_OVERRIDE` populated from the system of record.
2. **Given** the same asset, **When** the auditor requests `.cklb`, XCCDF, and
   OSCAL exports, **Then** all three files reference the same benchmark version
   (Title, Version, Release, SHA-256) and contain the same set of Vuln IDs and
   statuses.
3. **Given** an auditor with `auditor` role, **When** they attempt to edit a
   finding status, **Then** the system denies the action and writes an
   `ACCESS_DENIED` audit record.

---

### User Story 2 — Operator triggers an evaluation across an Arc-connected estate (Priority: P1)

An operator responsible for a hybrid environment selects a Collection
containing Azure VMs and Arc-connected on-prem servers, triggers an
on-demand evaluation, watches per-asset progress, and reviews newly produced
findings as they arrive.

**Why this priority**: Continuous evaluation is what differentiates this
product from a checklist editor. Arc parity (treating on-prem and Azure-native
hosts identically) is the headline capability.

**Independent Test**: In mock mode, two assets exist — one
`Microsoft.Compute/virtualMachines`, one `Microsoft.HybridCompute/machines`.
Triggering a scan on the Collection produces findings for both within the
simulated SLA, and the UI shows identical detail surfaces for each.

**Acceptance Scenarios**:

1. **Given** a Collection contains both Azure-native and Arc-connected servers,
   **When** the operator triggers an on-demand evaluation, **Then** the system
   creates one `Scan` record per asset, dispatches the appropriate evaluator
   for each platform, and updates each asset's status to `Evaluating` then
   `Evaluated` as results arrive.
2. **Given** a scan completes, **When** results arrive, **Then** every produced
   finding carries a complete trace: signal source → Vuln_Num → Rule_ID → CCI →
   NIST 800-53 control, and the benchmark version is recorded with SHA-256.
3. **Given** a scan fails for an asset (agent offline, permission denied,
   timeout), **When** the operator views the asset, **Then** the failure
   reason, timestamp, and remediation guidance are displayed and the asset's
   prior findings are preserved unchanged.

---

### User Story 3 — Admin manages collections, roles, and exceptions (Priority: P2)

An administrator defines a Collection (an ATO boundary), assigns assets to it
via tag-based or explicit selection rules, grants users the `auditor`,
`operator`, or `admin` role for that Collection, and approves or rejects
exception requests submitted by operators.

**Why this priority**: Required for multi-team / multi-system deployments;
without it the product only works for a single boundary.

**Independent Test**: An admin creates a new Collection with a tag rule
(`env=prod and ato=BoundaryX`), assets matching the rule appear within 60s, an
operator submits an exception with an expiration date, the admin approves it,
and findings under the exception render as `Not_Applicable` with the
exception's justification visible until expiration.

**Acceptance Scenarios**:

1. **Given** an admin creates a Collection with a tag-based rule, **When** the
   rule evaluates, **Then** matching assets appear in the Collection and
   non-matching assets do not.
2. **Given** an operator submits an exception with a future expiration,
   **When** the admin approves it, **Then** affected findings reflect the
   exception until expiration and revert automatically afterward; both
   transitions are recorded in the audit log.
3. **Given** an admin assigns a user the `operator` role on Collection A only,
   **When** that user attempts to view or modify Collection B, **Then** the
   request is denied and the denial is audit-logged.

---

### User Story 4 — Quarterly STIG content refresh (Priority: P2)

When DISA publishes its quarterly STIG release, the system automatically
ingests the new content, validates it, and presents administrators with a
diff (added / changed / removed Rules) before activating the new version.

**Why this priority**: Keeps the product current without manual ops effort and
preserves traceability of prior findings against prior versions.

**Independent Test**: A simulated quarterly drop is placed in the content
source; the system fetches it, verifies its SHA-256 against the signed
manifest, presents the admin a diff, and on activation begins evaluating new
scans against the new version while leaving prior findings bound to their
prior version.

**Acceptance Scenarios**:

1. **Given** a new quarterly content set is available, **When** the refresh
   job runs, **Then** the system downloads it, verifies provenance, stores it
   immutably, and notifies admins.
2. **Given** an admin reviews the diff, **When** they activate the new
   version, **Then** subsequent scans use the new version and prior findings
   remain bound to the version under which they were produced.
3. **Given** content provenance verification fails, **When** the refresh job
   runs, **Then** the new content is rejected, an alert is raised, and the
   prior version remains active.

---

### User Story 5 — Demo/Evaluator runs the full app in mock mode (Priority: P2)

A prospective adopter clones the repo, runs `docker compose up`, and
experiences the full product — sign-in, dashboards, scans, exports — using
deterministic sample data, with no Azure tenant required.

**Why this priority**: Drives adoption, enables CI/E2E, and is required by the
constitution.

**Independent Test**: A clean machine with only Docker installed can run
`docker compose up` and reach a working dashboard with seeded Collections,
assets, and findings, plus a working `.ckl` export — within 5 minutes.

**Acceptance Scenarios**:

1. **Given** `MOCK_MODE=true`, **When** the app starts, **Then** the user is
   signed in as a "Demo Admin" and the dashboard shows seeded Collections.
2. **Given** mock mode, **When** any export is requested, **Then** the
   resulting file is byte-stable across runs (deterministic).
3. **Given** mock mode, **When** any connector is invoked, **Then** no
   outbound call to Azure or `cyber.mil` is made.

---

### User Story 6 — POA&M / exception lifecycle (Priority: P3)

An operator records a Plan of Action & Milestones (POA&M) entry against an
open finding, sets a target remediation date, and tracks progress; on
remediation, the next scan automatically closes the finding and the POA&M
entry is marked complete.

**Why this priority**: Useful for full RMF parity but not required for MVP
exports; can be served initially by integration with C-PAT or STIG Manager.

**Independent Test**: In mock mode, an operator opens a failing finding,
attaches a POA&M with a target date and milestones, and the next mock scan
producing a `NotAFinding` result for that Rule transitions the POA&M to
`Closed` automatically.

**Acceptance Scenarios**:

1. **Given** a POA&M entry exists for a finding, **When** the underlying Rule
   evaluates as compliant in a subsequent scan, **Then** the POA&M is closed
   and the closure is audit-logged.
2. **Given** a POA&M entry's target date has passed, **When** the daily check
   runs, **Then** the entry is flagged `Overdue` and the assigned operator is
   notified.

---

### Edge Cases

- An Arc-connected machine is offline for a scheduled scan. → Asset status is
  `Stale`; last-known findings are preserved with their last-evaluated
  timestamp; UI shows a `Stale` badge and the time since last successful scan.
- A STIG Rule applies to a tech area not represented in the asset's metadata
  (e.g., an asset has no IIS role but an IIS Rule appears). → The Rule is
  filtered out by the applicability layer; the filter decision is logged and
  visible from the asset's "Why this Rule was/was not evaluated" panel.
- A Rule has no available signal source in Azure (e.g., requires physical
  inspection). → The finding defaults to `Not_Reviewed` with a structured
  reason `MANUAL_REVIEW_REQUIRED`; auditors and operators can manually set
  status with a comment.
- An asset is removed from Azure between scans. → Asset is marked `Retired`
  with the timestamp; historical findings remain queryable for ATO
  reproducibility but the asset is excluded from current rollups.
- A user's role is revoked mid-session. → On the next request the backend
  rejects the token claim set; the UI redirects to sign-in; the revocation is
  audit-logged.
- A `.ckl` import comes from an external scanner (e.g., Evaluate-STIG run on
  a disconnected host). → The file is accepted, parsed, mapped to an existing
  asset (or a new "imported" asset), and findings merge under the rule
  "external evidence wins on `MANUAL_REVIEW_REQUIRED`, automated wins on all
  other Rules unless explicitly overridden."
- Two scans for the same asset complete out of order. → The system orders by
  `Scan.completedAt`; the latest result wins; the older result remains in
  history.
- Export of a Collection with 10,000 assets. → Server streams the response;
  client renders a progress indicator; export completes within the SLA
  defined in SC-006 or fails with a recoverable error.

## Requirements *(mandatory)*

### Functional Requirements

**Authentication & Authorization**
- **FR-001**: System MUST authenticate every request via Microsoft Entra ID
  (OIDC + JWT) and MUST reject anonymous access to all endpoints except
  `/healthz` and `/readyz`.
- **FR-002**: System MUST enforce three roles — `admin`, `operator`,
  `auditor` — scoped per Collection, and MUST deny any action whose required
  role is not held by the caller for that Collection.
- **FR-003**: System MUST write an `AuditLog` record for every successful and
  every denied state-changing action, with actor, role, action, before/after,
  source IP, correlation ID, and UTC timestamp.

**Discovery & Inventory**
- **FR-004**: System MUST discover assets across one or more Azure
  subscriptions, including `Microsoft.Compute/virtualMachines`,
  `Microsoft.HybridCompute/machines` (Azure Arc-enabled servers),
  Arc-enabled Kubernetes, AKS, App Service, SQL, Storage, Key Vault, and
  network resources, and refresh inventory at least every 24 hours.
- **FR-005**: System MUST allow administrators to organize assets into
  Collections (ATO boundaries) using either tag-based selection rules or
  explicit assignment.

**Evaluation**
- **FR-006**: System MUST support scheduled and on-demand evaluations of any
  Collection, asset group, or single asset.
- **FR-007**: System MUST evaluate guest-OS-resident STIGs (Windows, Linux)
  using Azure Machine Configuration audit packages on both Azure-native and
  Azure Arc-connected machines.
- **FR-008**: System MUST evaluate Azure control-plane STIGs/SRGs using Azure
  Policy compliance state, Defender for Cloud assessments, Resource Graph
  queries, and ARM-derived metadata.
- **FR-009**: Each finding MUST be bound to a specific Vuln_Num, Rule_ID,
  CCI, and NIST 800-53 control, and MUST record the benchmark Title, Version,
  Release, Release Date, and SHA-256 of the source artifact.
- **FR-010**: When no signal source is available for a Rule applicable to an
  asset, the finding MUST default to `Not_Reviewed` with a structured reason
  rather than be silently dropped.

**Exceptions**
- **FR-011**: Operators MUST be able to submit exceptions with a
  justification, affected Rules and assets, and an expiration date; admins
  MUST be able to approve/reject; on expiration, the exception MUST
  automatically revert.

**Exports & Imports**
- **FR-012**: System MUST export `.ckl`, `.cklb`, XCCDF, OSCAL, and CSV for
  any asset, group of assets, or Collection.
- **FR-013**: Exports MUST preserve fields under round-trip: a `.ckl`
  exported by this system, opened in DISA STIG Viewer, saved, and re-imported
  MUST contain the same Vuln IDs, statuses, finding details, comments, and
  severity overrides.
- **FR-014**: System MUST accept `.ckl` / `.cklb` / XCCDF imports from
  external scanners and merge them into the system of record per a
  documented precedence policy.

**Content Management**
- **FR-015**: System MUST automatically check for new STIG content from
  public.cyber.mil at least quarterly, verify SHA-256 of retrieved artifacts
  against a signed manifest, store new content immutably, and present
  administrators with a diff before activating it.

**Mock Mode**
- **FR-016**: System MUST support a `MOCK_MODE` configuration in which every
  feature works against deterministic seeded data with zero outbound calls to
  Azure or external services.

**Optional Integrations**
- **FR-017**: System SHOULD support an optional integration with NUWCDIVNPT
  STIG Manager via its OpenAPI 3.0.1 REST API as the system of record, where
  this product provides Azure-aware ingestion and the UI layer.

**Accessibility**
- **FR-018**: All UI surfaces MUST meet WCAG 2.1 AA; color MUST never be the
  sole indicator of status; every interactive element MUST be reachable by
  keyboard.

**Operational**
- **FR-019**: System MUST expose `/healthz` (liveness) and `/readyz`
  (readiness including database, identity, and content cache reachability).
- **FR-020**: System MUST emit structured logs and Application Insights
  telemetry for every request, scan, export, and audit event with a
  correlation ID propagated end-to-end.

### Key Entities

- **Tenant** — The Entra ID tenant the app authenticates against.
- **Collection** — A set of assets representing an ATO boundary or system
  package; carries selection rules, role assignments, and aggregate metrics.
- **Asset** — A single evaluable resource (Azure VM, Arc machine, AKS
  cluster, App Service, SQL DB, Storage account, etc.); carries identity
  (resource ID, hostname, FQDN, IP/MAC where applicable), metadata (OS, tech
  area, role, tags), and lifecycle status.
- **Benchmark** — A specific DISA STIG or SRG release identified by Title,
  Version, Release, Release Date, and SHA-256.
- **Rule** — A single check within a Benchmark, identified by Vuln_Num and
  Rule_ID, with severity, CCI references, NIST control mappings, and
  applicability predicates.
- **Mapping** — The deterministic linkage from a signal source (Resource
  Graph property, Policy state, Defender assessment, MC audit result) to a
  Rule.
- **Scan** — One evaluation pass against one Asset under one Benchmark
  version, with status, started/completed timestamps, evaluator identity,
  and outcome summary.
- **Finding** — The result for one Rule on one Asset at one point in time;
  carries status (Open / NotAFinding / Not_Applicable / Not_Reviewed),
  evidence, severity, severity override, finding details, comments, and
  references to its Scan, Rule, and Benchmark version.
- **Exception** — A time-bounded waiver of one or more Rules for one or
  more Assets, with justification, requester, approver, and expiration.
- **POA&M** — A remediation plan attached to one or more open Findings, with
  milestones, target date, owner, and lifecycle status.
- **AuditLog** — An immutable record of every state change in the system.
- **User / Role** — Identity from Entra ID and the Collection-scoped roles
  assigned to it.
- **ContentPack** — A versioned set of Benchmark definitions ingested from
  public.cyber.mil with provenance metadata.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An auditor can produce a STIG Viewer–compatible `.ckl` for any
  evaluated asset in under 15 seconds and the file opens cleanly in DISA STIG
  Viewer with all required fields populated, on the first attempt, in 100% of
  cases across the seeded mock-mode dataset.
- **SC-002**: From "trigger evaluation" to "all findings visible in the UI"
  for a Collection of 100 mixed Azure + Arc machines completes within 30
  minutes at the 95th percentile.
- **SC-003**: 100% of findings in any export carry a complete trace
  (signal → Vuln → Rule → CCI → NIST control + benchmark SHA-256). A finding
  missing any link is treated as a defect.
- **SC-004**: A new evaluator can run the full app in mock mode on a clean
  machine in under 5 minutes using only the documented quick-start.
- **SC-005**: Quarterly content refresh completes end-to-end (download,
  verify, diff, await approval, activate) without operator intervention
  beyond the explicit approval click; provenance failures never auto-activate.
- **SC-006**: Exporting a Collection of 10,000 assets completes within 5
  minutes at the 95th percentile or surfaces a recoverable error with a
  retry option; the server never holds the entire export in memory.
- **SC-007**: Every state-changing action produces an AuditLog record visible
  in the UI within 5 seconds of the action.
- **SC-008**: The dashboard achieves zero `serious` or `critical` axe-core
  violations on every page in CI.
- **SC-009**: After role revocation, the revoked user is rejected on their
  next request within 60 seconds.
- **SC-010**: Re-running an export against the same scan produces a
  byte-identical file (deterministic exports).

## Assumptions

- DISA STIG content remains available from public.cyber.mil and the DoD Cyber
  Exchange under the same publishing cadence and signed-manifest pattern used
  today.
- Azure Machine Configuration is enabled, or can be enabled, on target
  subscriptions for guest-OS evaluation; targets that disallow MC fall back
  to `Not_Reviewed` with a structured reason.
- Azure Arc agents are healthy on target on-prem hosts; offline hosts are
  handled per the "stale" edge case rather than treated as compliant.
- The product's primary identity provider is Microsoft Entra ID; other IdPs
  are out of scope for MVP.
- The MVP scope assumes a single-tenant deployment per customer; multi-tenant
  SaaS is out of scope.

## Out of Scope (MVP)

- Active remediation (the product reports and tracks; it does not push fixes).
- Network device STIGs requiring SSH/telnet enumeration without an Arc agent.
- Air-gapped deployments (documented as a future variant).
- Mobile device STIGs.
- Non-Azure cloud estate (AWS, GCP) — though architecture should not preclude
  later expansion.
- Outbound notifications (email, Teams, webhook) on finding/exception/POA&M
  events — UI + AuditLog surface state changes; push notifications deferred.
