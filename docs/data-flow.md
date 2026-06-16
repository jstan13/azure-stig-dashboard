# Data Flow

This document describes how data moves through the Azure STIG Dashboard at every stage.

---

## 1. Ingestion — Azure → Database

> **Pull model, not real-time.** The dashboard reads from the database; the
> database is refreshed only when a scan runs. Scans are triggered manually
> (`POST /api/scan/trigger`) or by the optional recurring scheduler
> (`SCAN_SCHEDULE_ENABLED=true`, cadence via `SCAN_CRON_SCHEDULE` —
> [`scanScheduler.ts`](../backend/src/scanning/scanScheduler.ts), off by default).
> Each run is a batch pull whose cost scales with fleet size; overlapping runs
> are skipped. On a new deployment coverage fills in **gradually** — inventory on
> the first run, Policy/Defender posture once Azure finishes evaluating
> (~30 min–24 h), and the bulk (~80–90%) only after Guest Configuration reports
> in, which can take **hours to days**. See README "Schedule automatic refreshes".

```
Trigger (scheduler / POST /api/scan/trigger)
  │
  ▼
ScanOrchestrator.runScan(options)
  ├─ ResourceGraphConnector.scan()
  │     Azure Resource Graph API → list VMs, resource groups, tags
  │     Normalised → Machine[] records (hostname, OS, resourceId, ...)
  │
  ├─ PolicyConnector.scan()
  │     Azure Policy complianceStates API
  │     → per-resource compliance state for each policy assignment
  │     → mapped to Control.azurePolicyId
  │
  ├─ DefenderConnector.scan()
  │     Microsoft Defender for Cloud assessments API
  │     → security recommendations with severity
  │     → mapped to Control.defenderRuleId
  │
  ├─ Guest Configuration ingestion (ingestGuestConfiguration)
  │     Azure Guest Configuration assignment reports API
  │     → per-VM in-guest DSC compliance (registry, audit policy, services, …)
  │     → mapped to Control via vulnId; the bulk (~80-90%) of a STIG
  │     → set GUEST_CONFIG_INGEST=off to skip when GC is not deployed
  │
  └─ ARMConnector.scan()
        Azure Compute API → VM details, OS info, extension list
        Checks: GuestConfiguration agent present, MMA/AMA agent

  All results merged into ScanResult {
    machines[], findings[], controls[], metadata
  }

ScanOrchestrator.persistResults()
  ├─ upsert Machine rows (resourceId = PK equivalent)
  ├─ upsert Finding rows (machineId + controlId = composite key)
  │     ▸ Best-source precedence: the highest-fidelity source wins; a weaker
  │       signal (Policy/Defender) never downgrades a stronger in-guest result,
  │       and no automated scan overwrites a human reviewer's decision.
  │       See backend/src/scanning/sourceFidelity.ts
  ├─ update Scan record (status, summary counts recomputed from DB)
  └─ append AuditLog entry
```

**Source precedence (fidelity, highest first):** `manual`/`stig-manager`
(human) ▸ `powerstig` ▸ `scc` ▸ `openscap`/`scap` ▸ `guest-configuration` ▸
`defender` ▸ `azure-policy` ▸ `resource-graph`. In-guest scanners read actual OS
state and outrank cloud-plane connectors, which only cover a thin slice of a
STIG. Guest Configuration (or the PowerSTIG/SCAP Run Command path) is required
to reach full coverage — see the README "Source coverage & precedence" section.

**Mock mode** (`MOCK_MODE=true`): connectors return pre-seeded data from
`mockSeed.ts` without making any HTTP calls.

---

## 2. Control Mapping — Azure Artefacts → STIG IDs

```
Raw finding from Policy/Defender connector
  └─ policyDefinitionId or defenderRuleId
       │
       ▼
ControlMapping table  (control_mappings)
  ├─ sourceType + sourceId  → controlId   (confidence 1 = direct, 2 = transitive)
  └─ populated by backend/src/data/controlMappingSeeder.ts

Control record
  ├─ stigId            (e.g. WN10-AU-000005)
  ├─ vulnId            (e.g. V-220700)
  ├─ ruleId            (e.g. SV-220700r849121_rule)
  ├─ ccis[]            (e.g. CCI-000130) ──┐
  ├─ severity          (CAT I / II / III)  │ transitive expansion
  ├─ title             (short description)  │
  └─ checkText / fixText (STIG procedures)  │
                                            ▼
                                CCI → NIST 800-53 (cciNistMapping.ts)
                                            ▼
                                NIST control → Azure Policy (nistAzurePolicyMap.ts
                                  + scripts/build-nist-policy-map.ps1 overlay)
```

**How the mapping table is built** (`controlMappingSeeder.rebuildControlMappings`,
run automatically after each STIG import and via `POST /api/controls/mappings/rebuild`):

1. **Direct (confidence 1)** — explicit STIG-rule → Azure source pairs from the
   operator-maintained `docs/example-mapping.json` (or `CONTROL_MAPPING_FILE`) and
   from each Control's `azurePolicyIds` / `defenderRuleIds` columns.
2. **Transitive (confidence 2)** — every rule carries CCIs; CCIs resolve to NIST
   800-53 controls; any Azure source known for that NIST control is fanned out to
   all rules sharing it. A few authoritative direct mappings thereby cover
   hundreds of related controls.

The authoritative NIST → Azure Policy data is Microsoft's built-in
"NIST SP 800-53 Rev. 5" initiative; regenerate the exact GUIDs from your tenant
with `scripts/build-nist-policy-map.ps1`. Check current coverage at
`GET /api/controls/mappings/coverage`. See `docs/example-mapping.json` for the
direct-mapping file shape.

---

## 3. Dashboard — Database → Frontend

```
Browser loads /dashboard
  │
  ├─ GET /api/machines?page=1&pageSize=20
  │     └─ Machine[] with latestScan, complianceScore, findingCounts
  │           │
  │           └─ Dashboard KPI cards, BarChart (score per machine)
  │
  ├─ GET /api/scan (latest scan info for header)
  │
  └─ ComplianceDonut: aggregated open/closed/na counts from machine list

Browser loads /machines/:id
  ├─ GET /api/machines/:id
  │     └─ full Machine with Finding[] (all controls for that machine)
  │
  └─ ComplianceDonut + findings DetailsList + per-finding edit Panel
        PATCH /api/machines/:machineId/findings/:findingId
          └─ update status, comments, findingDetails
          └─ AuditLog entry created

Browser loads /groups/:id
  ├─ GET /api/groups                         (id=all → list all RGs)
  └─ GET /api/groups/:id/compliance          (specific RG rollup)
        └─ per-control failing machine count, BarChart
```

---

## 4. Export — Database → STIG Viewer file

```
User clicks "Export .ckl" on MachinePage or GroupPage
  │
  ▼
POST /api/export/checklist
  Body: { machineId?, groupId?, format: "ckl"|"json"|"csv", stigTitle, stigVersion }
  │
  ├─ [ckl]  CKLExporter.generateCKL(options)
  │           xml2js.Builder produces XML tree:
  │           <CHECKLIST>
  │             <ASSET> hostname, IP, FQDN, MAC, OS ...
  │             <STIGS>
  │               <iSTIG>
  │                 <STIG_INFO> title, version, classification
  │                 <VULN> × N findings
  │                   <STATUS>   Open | NotAFinding | Not_Applicable | Not_Reviewed
  │                   <FINDING_DETAILS>  operator comments
  │                   <COMMENTS>         additional notes
  │                   <STIG_DATA>        VUID, SV_ID, Rule_ID, Severity, ...
  │           Response: Content-Disposition: attachment; filename=...ckl
  │           Browser triggers file download
  │
  ├─ [json] JSON.stringify(findings[]) → attachment download
  └─ [csv]  CSV row per finding         → attachment download
```

---

## 5. Authentication Flow (MSAL)

```
Browser (un-authenticated)
  └─ MsalProvider + UnauthenticatedTemplate → /login page

User clicks "Sign in with Azure AD"
  └─ useMsal().instance.loginRedirect(loginRequest)
        Azure AD → consent screen → redirect_uri callback
        MSAL stores access_token + id_token in sessionStorage

Authenticated requests
  └─ useApi() hook (Axios instance)
        interceptor: instance.acquireTokenSilent({ scopes: [apiRequest.scopes] })
        sets header:  Authorization: Bearer <access_token>

Backend
  └─ authenticate middleware (auth/jwt.ts JwtValidator — jose + JWKS)
        fetches JWKS from https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys
        verifies signature + aud + iss
        attaches canonical principal (oid, appRoles, groups) to req.principal

  └─ requirePermission('findings:write', scopeByMachineParam('machineId'))
        roleResolver merges app roles + group mappings + role bindings
        into global + per-Collection grants, then can() decides
        403 if the principal lacks the permission in the request's scope
```
