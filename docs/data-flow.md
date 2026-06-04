# Data Flow

This document describes how data moves through the Azure STIG Dashboard at every stage.

---

## 1. Ingestion — Azure → Database

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
  └─ ARMConnector.scan()
        Azure Compute API → VM details, OS info, extension list
        Checks: GuestConfiguration agent present, MMA/AMA agent

  All results merged into ScanResult {
    machines[], findings[], controls[], metadata
  }

ScanOrchestrator.persistResults()
  ├─ upsert Machine rows (resourceId = PK equivalent)
  ├─ upsert Finding rows (machineId + controlId = composite key)
  ├─ update Scan record (status, summary counts)
  └─ append AuditLog entry
```

**Mock mode** (`MOCK_MODE=true`): connectors return pre-seeded data from
`mockSeed.ts` without making any HTTP calls.

---

## 2. Control Mapping — Azure Artefacts → STIG IDs

```
Raw finding from Policy/Defender connector
  └─ policyDefinitionId or defenderRuleId
       │
       ▼
ControlMapping table
  ├─ azurePolicyId  → Control.stigId  (e.g. V-220700)
  └─ defenderRuleId → Control.stigId

Control record
  ├─ stigId            (e.g. V-220700)
  ├─ ruleId            (e.g. SV-220700r849121_rule)
  ├─ severity          (CAT I / II / III)
  ├─ title             (short description)
  └─ checkText / fixText (STIG check & fix procedures)
```

See `docs/example-mapping.json` for the full mapping table.

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
