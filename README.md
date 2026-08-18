# Azure STIG Dashboard (Co-Pilot Generated)

A production-ready full-stack TypeScript dashboard for tracking STIG compliance of Azure workloads. Ingests data from Azure Resource Graph, Azure Policy, Microsoft Defender for Cloud, and ARM, normalises findings against STIG controls, and produces STIG Viewer-compatible `.ckl` exports.

### Easiest path — one command

If you have the [Azure CLI](https://aka.ms/installazurecli) and [Azure Developer CLI](https://aka.ms/install-azd) installed, this is the whole deployment:

```pwsh
git clone https://github.com/jstan13/azure-stig-dashboard.git
cd azure-stig-dashboard
./scripts/deploy.ps1 -OrgName <your-org> -Location eastus
```

The script signs you in (device-code), creates the Entra app registration with the correct API scope + admin/operator/auditor roles + redirect URI, generates a database password, runs `azd up`, and grants the backend managed identity `Reader` + `Security Reader` at subscription scope. You'll be granted the `admin` role on your own user automatically so the first login works.

When it finishes, browse to `https://<your-org>-stig-web.azurewebsites.net` and sign in.

### Deploy to Azure (portal wizard)

Prefer clicking a button? Use these. They run the same Bicep template but ask you to paste tenant ID, client ID, and client secret. Run `./scripts/create-app-registration.ps1 -OrgName <your-org>` first — it prints the three values you need.

| Cloud | Button |
|---|---|
| **Azure Commercial** (`portal.azure.com`) | [![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fgithub.com%2Fjstan13%2Fazure-stig-dashboard%2Freleases%2Flatest%2Fdownload%2Fazuredeploy.json/createUIDefinitionUri/https%3A%2F%2Fgithub.com%2Fjstan13%2Fazure-stig-dashboard%2Freleases%2Flatest%2Fdownload%2FcreateUiDefinition.json) |
| **Azure US Government** (`portal.azure.us`) | [![Deploy to Azure US Gov](https://aka.ms/deploytoazuregovbutton)](https://portal.azure.us/#create/Microsoft.Template/uri/https%3A%2F%2Fgithub.com%2Fjstan13%2Fazure-stig-dashboard%2Freleases%2Flatest%2Fdownload%2Fazuredeploy.json/createUIDefinitionUri/https%3A%2F%2Fgithub.com%2Fjstan13%2Fazure-stig-dashboard%2Freleases%2Flatest%2Fdownload%2FcreateUiDefinition.json) |

> The buttons resolve to the **latest GitHub Release** of this repo. Each release ships a fresh `azuredeploy.json` whose container image parameters are pinned to immutable `@sha256:<digest>` references built by GitHub Actions and signed via Sigstore cosign (keyless OIDC). Deployers can independently verify the signatures before deploying — see [docs/verifying-releases.md](docs/verifying-releases.md).

> The portal path runs the app **from those container images** (App Service pulls them straight from `ghcr.io`) and the scheduler Function from the `scheduler.zip` asset attached to the release — no source build, no `azd` required. The `azd` path leaves the image parameters empty and deploys from source instead.

> **Repo owners / forkers:** the `stig-backend` and `stig-frontend` GHCR packages must be set to **Public** (repo → Packages → package → *Package settings* → *Change visibility*). App Service pulls them anonymously, so a private package leaves both Web Apps stuck on image-pull errors. The release workflow verifies this and fails the release if either package is private.

> The two buttons load the **same** template + UI definition; the difference is which sovereign portal hosts the deployment blade. Choose the one matching the cloud your tenant lives in. Inside the wizard you can still pick `AzureCloud`, `AzureUSGovernment`, or `AzureUSGovernmentDoD` — the template will adjust App Service hostnames (`.azurewebsites.net` vs `.azurewebsites.us`), the PostgreSQL DNS zone, and the Microsoft Entra authority (`login.microsoftonline.com` vs `login.microsoftonline.us`) accordingly.

> If you forked this repo, replace `jstan13/azure-stig-dashboard` in the URLs above with `<your-org>/<your-repo>` and cut your own tagged release (`git tag v1.0.0 && git push origin v1.0.0`). The release workflow does the rest.

---

## Table of Contents

1. [Architecture overview](#architecture-overview)
2. [Features](#features)
3. [Quick start — mock mode (no Azure required)](#quick-start--mock-mode)
4. [One-click Deploy to Azure](#one-click-deploy-to-azure)
5. [Deploy with `azd up` (recommended for prod)](#deploy-with-azd-up-recommended-for-prod)
6. [Sizing & monthly cost estimates](#sizing--monthly-cost-estimates)
7. [Where this fits in your STIG toolchain](#where-this-fits-in-your-stig-toolchain)
8. [Using the dashboard](#using-the-dashboard)
9. [Azure AD app registration](#azure-ad-app-registration)
10. [GitHub Secrets configuration](#github-secrets-configuration)
11. [Local development — real Azure data](#local-development--real-azure-data)
12. [Database migrations](#database-migrations)
13. [Running tests](#running-tests)
14. [Project structure](#project-structure)
15. [API reference](#api-reference)
16. [Export formats](#export-formats)
17. [Contributing](#contributing)
18. [Security](#security)
19. [License](#license)

---

## Architecture overview

```
React (Fluent UI + MSAL.js)
        │  HTTPS + Azure AD JWT
        ▼
Express API (Node 20 / TypeScript)
  ├── Azure Resource Graph connector
  ├── Azure Policy connector
  ├── Defender for Cloud connector (assessments + sub-assessments)
  ├── ARM connector
  ├── eMASS v3 REST connector (mTLS)
  └── CKL / CKLB / JSON / CSV exporters
        │
        ▼
PostgreSQL 16 (TypeORM)
        │
Azure Functions (timer)  ── nightly scan + 6 h drift check → Teams
Log Analytics workspace  ── SIEM forwarding (Sentinel / Splunk)
Azure AD                 ── Auth tokens + Function MI -> backend
App Insights             ── Telemetry
```

Full details: [docs/architecture.md](docs/architecture.md) · [docs/data-flow.md](docs/data-flow.md)

---

## Features

| Area | Details |
|------|---------|
| **Auth** | MSAL.js v3 (SPA) + express-jwt RBAC (admin / operator / auditor) |
| **Ingestion** | Resource Graph · Policy compliance states · Defender assessments · ARM VM metadata · **Azure Arc-connected machines** |
| **Data model** | 13 TypeORM entities: Machine, Control, Finding, Scan, Checklist, Exception, AuditLog, … |
| **Dashboard** | Compliance donut, per-machine bar chart, inventory table, audit timeline |
| **Findings** | Per-control status edit, comments, finding details — all logged to audit trail |
| **Export** | STIG Viewer `.ckl` XML · JSON · CSV |
| **Mock mode** | `MOCK_MODE=true` — full app with demo data, zero Azure credentials needed |
| **CI/CD** | GitHub Actions lint → test → Docker → App Service deploy |
| **IaC** | Bicep + ARM JSON (Deploy-to-Azure button) |

---

## Quick start — mock mode

No Azure subscription or credentials required.

### Docker Compose (recommended)

```bash
git clone https://github.com/YOUR_ORG/azure-stig-dashboard.git
cd azure-stig-dashboard
docker compose up --build
```

| Service  | URL                          |
|----------|------------------------------|
| Frontend | http://localhost              |
| Backend  | http://localhost:3001         |
| API docs | http://localhost:3001/api/docs |

### Local dev servers

**Prerequisites:** Node.js 20+, npm 10+

```bash
# Install all workspace dependencies
npm install

# Start backend dev server
cd backend
cp ../sample.env .env          # MOCK_MODE=true already set
npm run dev                    # ts-node + nodemon on :3001

# Start frontend dev server (new terminal)
cd frontend
cp ../sample.env .env          # VITE_MOCK_MODE=true already set
npm run dev                    # Vite on :5173 → proxies /api → :3001
```

Open http://localhost:5173. You are signed in automatically as **Demo Admin** in mock mode.

---

## One-click Deploy to Azure

Click one of the buttons at the top of this README — Commercial uses `portal.azure.com`, US Gov uses `portal.azure.us`. The portal renders a four-step wizard powered by [`infra/createUiDefinition.json`](infra/createUiDefinition.json):

1. **Basics** — Organization name (resource prefix), Azure cloud environment, region, App Service SKU, MOCK mode toggle.
2. **Microsoft Entra sign-in** — Tenant ID, app registration client ID + secret.
3. **PostgreSQL** — admin login + complex password.
4. **Review + create**.

The ARM template provisions:

| Resource | SKU / tier |
|---|---|
| App Service Plan | B1 Linux (configurable) |
| Backend App Service | Node 20 LTS |
| Frontend App Service | Node 20 LTS (Vite static bundle) |
| PostgreSQL Flexible Server | Burstable B1ms + `AllowAzureServices` firewall rule |
| Application Insights | Pay-as-you-go |

### Sovereign cloud support (Azure US Gov / DoD)

The template is fully cloud-aware. Selecting `AzureUSGovernment` or `AzureUSGovernmentDoD` in the wizard automatically substitutes:

| Resource | Commercial | Azure US Gov |
|---|---|---|
| App Service hostname | `*.azurewebsites.net` | `*.azurewebsites.us` |
| PostgreSQL DNS | `*.postgres.database.azure.com` | `*.postgres.database.usgovcloudapi.net` |
| Microsoft Entra authority | `login.microsoftonline.com` | `login.microsoftonline.us` |
| ARM endpoint | `management.azure.com` | `management.usgovcloudapi.net` |
| Microsoft Graph | `graph.microsoft.com` | `graph.microsoft.us` |

The backend reads `AZURE_AUTHORITY_HOST`, `AZURE_ARM_ENDPOINT`, and `AZURE_GRAPH_ENDPOINT` from app settings, so JWT validation, JWKS fetches, and Azure SDK clients all target the correct sovereign endpoints automatically.

**Before deploying** you must:
1. Complete the [Azure AD app registration](#azure-ad-app-registration) steps **inside the matching tenant** (Commercial AAD vs Gov AAD — they are separate directories).
2. Have your Tenant ID and Client IDs ready to paste into the wizard.

**After deploying** you must:
1. Note the `redirectUriToConfigure` deployment output and add it as an SPA redirect URI on the frontend app registration.
2. Navigate to the **backend App Service > Identity > System assigned** — note the Object ID.
3. Assign the managed identity the following Azure RBAC roles on each subscription you want to scan:
   - `Reader`
   - `Security Reader`
4. For Azure Arc-connected machines: the Arc agent on each on-premises server connects outbound to Azure — no additional Azure RBAC role is needed to read those resources, but the machine must be enrolled in Azure Arc first (`Microsoft.HybridCompute/machines` resource type). Assign the `Azure Connected Machine Resource Reader` built-in role to the managed identity if you need to query Arc-only resource groups.
5. For Policy data: `Reader` is sufficient for read-only compliance state queries.

---

## Deploy with `azd up` (recommended for prod)

If you've cloned the repo and have the [Azure Developer CLI](https://learn.microsoft.com/azure/developer/azure-developer-cli/install-azd) installed, this is the fastest path to a real production deployment. It runs the same Bicep template as the portal button but also builds and deploys both apps in one shot.

```pwsh
git clone https://github.com/<your-org>/azure-stig-dashboard.git
cd azure-stig-dashboard

azd auth login                      # add --use-device-code in restricted shells
azd env new prod                    # creates .azure/prod/ env
azd env set AZURE_TENANT_ID     <tenant-guid>
azd env set AZURE_CLIENT_ID     <backend-app-registration-client-id>
azd env set AZURE_CLIENT_SECRET <backend-app-registration-secret>
azd env set DB_ADMIN_PASSWORD   '<strong-password>'
azd env set MOCK_MODE           false                # IMPORTANT for prod
azd env set APP_SERVICE_SKU     S1                   # see sizing table below

# Cost-aware defaults (recommended for small deployments)
# azd env set AUTO_SIZE_BY_TRACKED_HOSTS true
# azd env set TRACKED_HOST_COUNT 25

# Optional — scheduled-scan Function App alert channel
# azd env set TEAMS_WEBHOOK_URL    https://outlook.office.com/webhook/...
# azd env set DRIFT_CAT1_THRESHOLD 0

# Optional — disable the Function App or SIEM diagnostics
# azd env set ENABLE_SCHEDULER     false
# azd env set ENABLE_DIAGNOSTICS   false

# Optional — business-hours mode + auto shutdown/start of app + DB
# azd env set BUSINESS_HOURS_MODE true
# azd env set BUSINESS_HOURS_TIME_ZONE America/New_York
# azd env set BUSINESS_HOURS_START_HOUR 8
# azd env set BUSINESS_HOURS_END_HOUR 18
# azd env set AUTO_SHUTDOWN_OUTSIDE_BUSINESS_HOURS true

# Optional sovereign cloud (Azure US Gov / DoD)
# azd env set AZURE_CLOUD AzureUSGovernment
# azd config set defaults.location usgovvirginia

azd up                              # provisions infra + builds + deploys
```

`azd up` will:

1. Provision the resource group + every resource defined in [infra/main.bicep](infra/main.bicep) (~10–15 min) including the **scheduled-scan Function App**, **Storage account**, and **Log Analytics workspace** for SIEM forwarding.
2. Store `AZURE-CLIENT-SECRET` and `DB-PASSWORD` in **Key Vault**, wired into App Service via Key Vault references — secrets are never logged.
3. Grant the backend's system-assigned managed identity the **Key Vault Secrets User** role.
4. Build the backend (`tsc`), frontend (`vite build`), and Function App (`tsc`) and deploy all three.
5. Run the post-deploy hook ([scripts/post-deploy.ps1](scripts/post-deploy.ps1)) which grants the Function App MI the **operator** app role on the backend Entra registration via Microsoft Graph and verifies the `api://` Application ID URI is set.
6. Apply pending TypeORM migrations on backend startup automatically — no manual `migration:run` step needed (override with `SKIP_AUTO_MIGRATIONS=true`).
7. Print the frontend URL, backend URL, and the **redirect URI you must register** on your SPA app registration.

**One-time post-deploy step (manual):**

```pwsh
# Add the printed redirect URI to the SPA app registration:
#    Entra ID > App registrations > <your-spa> > Authentication > Single-page application
```

To redeploy code-only changes later: `azd deploy` (or `azd deploy backend` / `frontend` / `scheduler` for a single service). To tear everything down: `azd down --purge`.

---

## Sizing & monthly cost estimates

This deployment is **reasonably cost-optimized by default** for a compliance dashboard (burstable Postgres, single shared App Service plan for frontend+backend, Consumption Function, no VNet/private endpoints by default), but the **big swing factor is observability ingestion** when diagnostics are enabled.

All numbers below are **public Azure Commercial, East US, pay-as-you-go, USD/month** from Azure retail pricing, and are meant as planning estimates.

### What the template provisions by default

| Resource | Default setting |
|---|---|
| App Service Plan (Linux) | `appServiceSku` (default parameter is `B1`; can auto-size from host count) |
| Backend App Service | Shares same plan |
| Frontend App Service | Shares same plan |
| PostgreSQL Flexible Server | `Standard_B1ms`, 32 GB storage, 7-day backup, no HA |
| Key Vault | Standard |
| Application Insights | Pay-as-you-go |
| Function App + Storage | Enabled by default (`enableScheduler=true`; can auto-disable for tiny footprints) |
| Log Analytics diagnostics | Enabled by default (`enableDiagnostics=true`; can auto-disable for tiny footprints) |

### Host-count-driven defaults

If `AUTO_SIZE_BY_TRACKED_HOSTS=true`, infrastructure defaults are inferred from `TRACKED_HOST_COUNT`:

| Tracked hosts | App Service SKU | Scheduler | Diagnostics |
|---|---|---|---|
| 1-25 | B1 | Off | Off |
| 26-150 | B1 | On | Off |
| 151+ | S1 | On | On |

`B1` is the minimum tier that supports custom containers and Always-On, so it is
used as the floor even for the smallest environments. Set
`AUTO_SIZE_BY_TRACKED_HOSTS=false` to use explicit `APP_SERVICE_SKU`,
`ENABLE_SCHEDULER`, and `ENABLE_DIAGNOSTICS` values.

### Business-hours mode

You can run scheduled jobs only during business hours and optionally auto-stop/start the web apps + PostgreSQL outside those hours:

- `BUSINESS_HOURS_MODE=true` enables business-hours gating for scheduler jobs.
- `AUTO_SHUTDOWN_OUTSIDE_BUSINESS_HOURS=true` enables scheduled ARM stop/start actions.
- `BUSINESS_HOURS_TIME_ZONE`, `BUSINESS_HOURS_START_HOUR`, and `BUSINESS_HOURS_END_HOUR` define the local business window.

This can materially reduce spend in small internal environments, at the cost of availability outside business hours.

> **Where the savings come from:** stopping the PostgreSQL Flexible Server pauses
> its compute billing (you keep paying only for storage). Stopping the web apps
> does **not** reduce App Service Plan cost — the plan bills 24/7 regardless — so
> the auto-stop savings are driven primarily by the database.

### Price points used (East US retail)

| Meter | Price used |
|---|---:|
| PostgreSQL Flexible Server `B1ms` compute | **$0.02/hour** (~$14.60/mo) |
| PostgreSQL Flexible Server storage | **$0.12/GB-month** (32 GB ~= $3.84/mo) |
| Log Analytics ingestion | **$2.30/GB** |
| Application Insights overage ingestion | **$2.30/GB** |
| Application Insights / Log Analytics retention | **$0.10/GB-month** |
| Key Vault operations | **$0.03 per 10,000 ops** |
| App Service Basic `B2` (shown by East US retail feed) | **$0.15/hour** (~$109.50/mo) |

Note: East US retail feed did not return `B1` for App Service during sampling, even though `B1` is in the template allowed values. Treat App Service plan price as **region-variant** and confirm in calculator for your target region.

### Estimated monthly total (what users should expect)

| Scenario | Assumptions | Estimated total |
|---|---|---:|
| Lean dev/test | B1/B2-class App Service, low telemetry (<1 GB/mo), low Log Analytics ingestion | **~$35 to $140/mo** |
| Typical internal production | B2-class App Service, ~0.5 GB/day diagnostics + telemetry, default DB/storage | **~$170 to $230/mo** |
| Heavier production | S1+ plan and ~1 GB/day+ diagnostics/telemetry | **~$240+/mo** |

### Cost optimization levers

| Lever | Impact |
|---|---|
| Set `enableDiagnostics=false` if you do not need centralized SIEM pipeline yet | Often biggest immediate savings |
| Keep Postgres on `Standard_B1ms` until CPU/IO pressure requires upgrade | Avoids large DB step-up cost |
| Keep one shared App Service plan for frontend+backend | Lowest web-hosting baseline |
| Tune log volume (sampling, fewer verbose logs) | Directly reduces $2.30/GB ingestion charges |
| Enable lockdown/private networking only when required | Security goes up, but networking/data-path costs can rise |

> Always validate final numbers with the official [Azure Pricing Calculator](https://azure.microsoft.com/pricing/calculator/) for your region and contract (EA/MCA discounts can materially change totals).

---

## Where this fits in your STIG toolchain

This dashboard is the **central system of record and reporting layer** for STIG compliance across your Azure (and Azure Arc-connected) estate. It is *not* a SCAP scanner, a vulnerability scanner, or a remediation engine on its own — it **orchestrates, ingests, normalises, and reports** on data those other tools produce.

### TL;DR — what to keep, what to retire

| Tool | Role | After deploying this dashboard |
|---|---|---|
| **DISA STIG Viewer 3** | Open/edit `.ckl` checklists | **Keep** — auditors still use it to review the `.ckl` files this dashboard exports |
| **eMASS** | DoD compliance system of record | **Keep** — upload our `.ckl` and POA&M exports; this dashboard is your day-to-day driver |
| **DISA SCAP Compliance Checker (SCC)** | Run SCAP scans on Windows hosts | **Optional** — invoke from this dashboard via Azure Run Command/Arc; results parsed by [`scapResultParser.ts`](backend/src/scanning/scapResultParser.ts) |
| **OpenSCAP / `oscap`** | Run SCAP scans on Linux hosts | **Built in** — [`openScapRunner.ts`](backend/src/scanning/openScapRunner.ts) drives oscap remotely; results auto-ingested |
| **PowerSTIG (DSC)** | Audit + remediate Windows hosts | **Built in** — [`powerStigRunner.ts`](backend/src/scanning/powerStigRunner.ts) + [`dscResultParser.ts`](backend/src/scanning/dscResultParser.ts) ingest DSC audit JSON; remediation triggered via [`remediationRunner.ts`](backend/src/scanning/remediationRunner.ts) |
| **Evaluate-STIG** (NSWC) | PowerShell-based STIG scanner | **Replaced** — same data class as PowerSTIG/SCAP runners above |
| **Azure Policy** | Resource configuration compliance | **Ingested** — [`policyConnector.ts`](backend/src/connectors/policyConnector.ts) maps Policy IDs → STIG controls |
| **Microsoft Defender for Cloud** | CSPM + workload protection | **Ingested** — [`defenderConnector.ts`](backend/src/connectors/defenderConnector.ts) maps assessment IDs → STIG controls |
| **Azure Resource Graph / ARM** | Resource inventory | **Ingested** — [`resourceGraphConnector.ts`](backend/src/connectors/resourceGraphConnector.ts), [`armConnector.ts`](backend/src/connectors/armConnector.ts) |
| **Azure Arc** | On-prem/multi-cloud machine onboarding | **Required** for non-Azure hosts you want to scan |
| **Azure Guest Configuration** | Push DSC/PowerSTIG to VMs and Arc machines | **Required for full STIG coverage** — [`guestConfigDeployer.ts`](backend/src/scanning/guestConfigDeployer.ts). Azure Policy + Defender alone cover only ~5–15% of a STIG (cloud-plane posture). The remaining in-guest OS settings are surfaced through Guest Configuration (or the PowerSTIG/SCAP Run Command path). See [Source coverage & precedence](#source-coverage--precedence). |
| **ACAS / Tenable Nessus** | Vulnerability (CVE) scanning | **Keep separate** — different data class (CVEs ≠ STIG rules); roadmap item below |
| **Splunk / Microsoft Sentinel** | SIEM / log correlation | **Keep** — point at this app's App Insights workspace; roadmap for native push |
| **Wazuh / OSSEC** | HIDS + SCAP | **Keep** if already deployed; we don't replace HIDS |
| **STIG Manager** (NSWC OSS) | Web app for managing `.ckl` files | **Replaced** — superset of features, plus Azure-native ingestion |

### What this dashboard is the source of truth for

- **Asset → control → finding → POA&M** lifecycle across all tenants/subscriptions
- **`.ckl` / JSON / CSV exports** for STIG Viewer and eMASS
- **RMF/NIST 800-53 control rollups** ([RmfPage](frontend/src/pages/RmfPage.tsx))
- **Compliance trend history** ([ComplianceTrendPage](frontend/src/pages/ComplianceTrendPage.tsx))
- **Audit log** of every scan, finding edit, exception, and export ([AuditPage](frontend/src/pages/AuditPage.tsx))

### Data-flow summary

```
                 ┌──────────────────────────────────────────────┐
                 │           Azure STIG Dashboard               │
                 │  (this app — Postgres + React + Express)     │
                 └──────────────────────────────────────────────┘
                          ▲                ▲              │
   ┌──────────────────────┘                │              │
   │  Resource Graph / ARM / Policy /      │              ▼
   │  Defender for Cloud (REST APIs)       │   .ckl / JSON / CSV
   │                                       │   ──► STIG Viewer 3
   │  PowerSTIG DSC results                │   ──► eMASS upload
   │  OpenSCAP XCCDF results               │
   │  SCC ARF / XCCDF results              │
   │  (pulled via Guest Config /            │
   │   Run Command on Azure + Arc VMs)     │
   │                                        │
   ▼                                        │
Azure VMs · Azure Arc machines ─────────────┘
(Windows + Linux, on-prem / multi-cloud)
```

---

### Source coverage & precedence

A single STIG control on a single host can be evaluated by more than one source.
They do **not** see the same things, so the dashboard records the result from the
**highest-fidelity source** for each `(machine, control)` pair and never lets a
weaker signal downgrade a stronger one. This selection is centralized in
[`sourceFidelity.ts`](backend/src/scanning/sourceFidelity.ts) and applied by every
ingestion path (scan orchestrator, PowerSTIG/DSC parser, SCAP parser, Guest
Configuration sync).

| Source | `sourceType` | Sees | Approx. STIG coverage | Fidelity |
|---|---|---|---|---|
| Human reviewer (manual / STIG Manager edit) | `manual`, `stig-manager` | Reviewer decisions, NA justifications, risk acceptance | n/a | **Highest — never auto-overwritten** |
| PowerSTIG (DSC) | `powerstig` | Real in-guest OS state (registry, audit policy, user rights, services, …) | ~80–90% | 100 |
| DISA SCC | `scc` | Windows SCAP/ARF in-guest results | ~80–90% | 95 |
| OpenSCAP / SCAP | `openscap`, `scap` | Linux/Windows SCAP/ARF in-guest results | ~80–90% | 90 |
| **Azure Guest Configuration** | `guest-configuration` | In-guest OS state via the GC agent (agentless to operate, fleet-wide) | ~80–90% | 85 |
| Microsoft Defender for Cloud | `defender` | Cloud-plane CSPM posture | thin slice | 50 |
| Azure Policy | `azure-policy` | Cloud-plane resource configuration | thin slice | 40 |
| Azure Resource Graph / ARM | `resource-graph` | Inventory / metadata only | none (inventory) | 20 |

**Why Guest Configuration is required for full coverage.** Azure Policy and
Defender for Cloud observe only the cloud control plane — they can answer a small
set of high-level controls (MFA, disk encryption, anti-malware presence, network
exposure) but **cannot read in-guest OS settings**, which are the bulk of any
STIG. To raise coverage from ~5–15% to ~80–90% you must deploy an in-guest
source. Azure Guest Configuration is the recommended fleet-wide option (it also
covers Azure Arc machines); the PowerSTIG/SCAP Run Command path is the
alternative. The remaining ~10–20% are pure `Manual` checks (documentation,
physical, procedural) that have no automated check by design.

The scan orchestrator pulls Guest Configuration compliance automatically during a
scan. Set `GUEST_CONFIG_INGEST=off` to skip it (e.g. in environments where GC is
not deployed); the scan then degrades gracefully to control-plane-only data.

---

### Control mapping build-out (Policy/Defender → STIG)

Cloud-plane findings (Azure Policy, Defender) arrive keyed by
`policyDefinitionId` / assessment id. The dashboard needs a join from those ids to
STIG controls; that join lives in the `control_mappings` table and is built by
[`controlMappingSeeder.ts`](backend/src/data/controlMappingSeeder.ts) in two tiers:

| Tier | Confidence | Source |
|---|---|---|
| **Direct** | 1 | Explicit STIG-rule → Azure-source pairs from [`docs/example-mapping.json`](docs/example-mapping.json) (override with `CONTROL_MAPPING_FILE`) and from each control's `azurePolicyIds` / `defenderRuleIds` columns. |
| **Transitive** | 2 | Each rule's CCIs resolve to NIST 800-53 controls ([`cciNistMapping.ts`](backend/src/data/cciNistMapping.ts)); any Azure source known for a NIST control ([`nistAzurePolicyMap.ts`](backend/src/data/nistAzurePolicyMap.ts)) fans out to every rule sharing it. A handful of authoritative mappings thereby cover hundreds of related controls. |

The seeder runs automatically after each STIG import. You can also drive it via the API:

```http
POST /api/controls/mappings/rebuild      # requires stig:import; rebuilds the table (real mode only)
GET  /api/controls/mappings/coverage      # controls mapped, % coverage, breakdown by source & confidence
```

**Authoritative NIST → Azure Policy data.** The curated registry in
`nistAzurePolicyMap.ts` is seeded with a representative subset. To pull the exact,
tenant-current GUIDs from Microsoft's built-in *NIST SP 800-53 Rev. 5* initiative,
run:

```powershell
./scripts/build-nist-policy-map.ps1   # writes backend/src/data/nistAzurePolicyMap.generated.json
```

The seeder automatically merges that generated overlay (or set
`NIST_POLICY_MAP_FILE` to point elsewhere), then rebuild via the endpoint above.
Using Azure-sourced GUIDs guarantees they match what the connectors observe at
runtime.

---

### Manual answers: answer once for a pool or platform

The ~10–20% of a STIG that is procedural/physical/documentation has no automated
check — a human must record the decision. Re-answering identical checks on every
Domain Controller (or every machine in a cloud) is wasteful, so manual answers
can be authored once at a broader **scope** and inherited:

| Scope | Applies to | Authored from |
|---|---|---|
| **Machine** | one machine's finding | machine detail → **Edit** finding → *This machine only* |
| **Pool** | every machine in an [Asset Pool](#using-the-dashboard) (role group) | finding editor → *Apply to all machines in a pool* |
| **Platform** | every machine on a derived platform (`azure`, `arc`, `arc-<cloud>`) | finding editor → *Apply to all machines on platform* |

Precedence is **machine > pool > platform > automated**: a more specific answer
is never overwritten by a broader one. The broader answers are stored in
`manual_answers` (source of truth) and **applied** onto member findings, so:

- newly-discovered machines automatically inherit applicable answers on their
  next scan ([`reapplyAllForMachine`](backend/src/services/manualAnswers.ts)), and
- editing one answer re-propagates to every member.

Platforms are derived with no data entry: native Azure VMs are `azure`; Azure
Arc-connected servers (which can run on-prem, AWS, or GCP and still report
in-guest state through Azure) are `arc`, refined to `arc-<cloud>` when a cloud
tag is present. See [`utils/platform.ts`](backend/src/utils/platform.ts).

API:

```http
GET    /api/pools                                  list pools (+ member/answer counts)
POST   /api/pools                                  create a pool
GET    /api/pools/:id                              pool detail + members
POST   /api/pools/:id/members                      add machines
DELETE /api/pools/:id/members/:machineId           remove a machine
PUT    /api/pools/:id/answers/:controlId           upsert + apply a pool answer
GET    /api/pools/platforms                         list platforms (+ counts)
PUT    /api/pools/platforms/:platform/answers/:controlId   upsert + apply a platform answer
```

Pool administration requires `collection:manage`; authoring answers requires
`findings:write`.

---

## Using the dashboard

After signing in, the left rail groups every page into three sections.

### Compliance

| Page | Path | What you do here |
|---|---|---|
| **Overview**          | `/dashboard`     | Tenant rollup, compliance score donut, CAT I/II/III heatmap, scan freshness KPIs. Drill in by clicking a tenant or severity tile. |
| **Cloud Explorer**    | `/explorer`      | Azure-portal-style tree of management group → subscription → resource group → machine. Click any node for its filtered findings. |
| **Machine Inventory** | `/inventory`     | Sortable / filterable table of every Azure + Arc machine. Click a row for the machine detail view (per-control status, comments, scan history, remediation actions). |
| **Resource Groups**   | `/groups/all`    | Group-level rollup with per-group compliance score and open CAT I count. |
| **Asset Pools**       | `/pools`         | Group machines by role (Domain Controllers, Web Servers, Build Servers…) so a manual STIG answer is authored **once** and inherited by every member. Also lists derived platforms. |

### Reporting

| Page | Path | What you do here |
|---|---|---|
| **Compliance Trends** | `/trends`           | Time-series of compliance score, CAT I drift, remediation throughput. Snapshots are taken nightly by the scheduler. |
| **POA&M**             | `/poams`            | Create / edit / close Plans of Action & Milestones. Bulk-create from open findings; export as CSV. |
| **Vulnerabilities**   | `/vulnerabilities`  | CVE-class findings from Microsoft Defender Vulnerability Management. Filter by severity/exploit availability, change status (Open / Mitigated / Risk Accepted / False Positive), or click **Sync from Defender** to pull a fresh batch. |
| **RMF / NIST**        | `/rmf`              | NIST 800-53 control coverage view, mapping STIG findings → RMF families. |
| **STIG Library**      | `/stigs`            | Browse benchmarks pulled from DISA, with version history and per-rule details. |

### Administration

| Page | Path | What you do here |
|---|---|---|
| **Bulk Remediation** | `/remediation` | Multi-select open findings across machines, choose severity filter, review the approval prompt, then push DSC/PowerSTIG remediation jobs in one batch. Recent jobs and their status are listed below. |
| **eMASS Sync**       | `/emass`       | Push all open POA&Ms or upload a CKLB checklist for a specific machine to eMASS. The page reports connector configuration status; if PEMs / API key are missing it explains exactly which App Settings to add. |
| **Audit Log**        | `/audit`       | Immutable log of every privileged action (scan triggered, status changed, POA&M edited, eMASS pushed, remediation job submitted). Filter by user, action, or date range. |
| **Users**            | `/users`       | View Entra-assigned roles (admin / operator / auditor). Role assignment itself is done in the Entra portal. |

### Common workflows

**1. Run a scan right now.**
Open *Machine Inventory* → select machines → **Trigger scan**. The orchestrator chooses PowerSTIG (Windows) or OpenSCAP (Linux) automatically. Or hit `POST /api/scan/trigger` from a CI pipeline.

**1a. Schedule automatic refreshes (how often *you* decide).**
The dashboard is a **database that is refreshed by scans**, not a live query against Azure — so it only changes when a scan runs. Automated scans are **off by default**; an operator opts in:

```bash
azd env set SCAN_SCHEDULE_ENABLED true        # turn the scheduler on
azd env set SCAN_CRON_SCHEDULE   "0 */6 * * *" # choose the cadence (every 6 h here)
```

Pick the cadence that matches how fresh you need the data:

| Cadence | `SCAN_CRON_SCHEDULE` | Good for |
|---|---|---|
| Hourly        | `0 * * * *`   | Active remediation / near-live tracking |
| Every 6 hours | `0 */6 * * *` | Balanced default for most teams |
| Nightly (2AM) | `0 2 * * *`   | Steady-state monitoring (lightest load) |
| Weekly (Sun)  | `0 2 * * 0`   | Slow-changing estates / audit prep |

> **Resource overhead.** Each run is a **batch pull** across Resource Graph, Policy, Defender, ARM, and Guest Configuration. Cost scales with fleet size — roughly a few API calls per subscription plus per VM, so a few hundred VMs is a few minutes of work and a brief CPU/network spike on the backend container. Calls are **read-only** but count against ARM/Resource Graph throttling limits, so prefer **hourly-or-slower** on large fleets (very frequent schedules can hit HTTP 429). Each run also writes a `Scan` row + a compliance-history snapshot, so the DB grows slowly and linearly with frequency. **Overlapping runs are skipped** — if a scan is still going when the next tick fires, the tick is logged and dropped rather than stacking concurrent scans.

> **First-time fill-in can take days.** The scheduler only surfaces what Azure has *already evaluated*. On a brand-new deployment the dashboard populates **gradually**: inventory (machines/OS/RGs) appears on the **first run**; Azure Policy + Defender posture (~5–15% of a STIG) appears once Azure finishes evaluating assignments (**~30 min, up to ~24 h**); and the bulk of a STIG (~80–90%) only after **Guest Configuration is deployed to the VMs and reports back** — which can take **hours to days** to fully populate across a fleet. Scanning more often does **not** speed up Azure's own evaluation; it just refreshes what is ready. Expect the compliance picture to climb over the first few days, then stabilise.

For business-hours gating, retries, and bundling vulnerability sync + history snapshots, the [Azure Functions timer](functions/README.md) (`scheduledScan`) is an alternative that calls the same endpoint from outside the app.

**2. Get a Teams alert when CAT I drift happens.**
Set `TEAMS_WEBHOOK_URL` in azd (`azd env set TEAMS_WEBHOOK_URL https://outlook.office.com/...`) before `azd up`, or set it on the Function App after the fact. The `complianceDriftCheck` function runs every 6 hours and posts to the channel when CAT I open or critical/exploitable CVE counts cross your `DRIFT_CAT1_THRESHOLD`.

**3. Push everything you have to eMASS.**
On the **eMASS Sync** page, pick the target eMASS system and click **Push all open POA&Ms**. To upload a CKLB for a single host, paste the machine ID and click **Upload CKLB**. Both actions are written to the audit log.

**4. Forward logs to Sentinel / Splunk.**
The deployment provisions a Log Analytics workspace and pipes all four resources (backend, frontend, Function App, Key Vault) into it. Connect Sentinel to that workspace, or use a Splunk add-on with the same workspace ID — no app changes needed.

**5. Bulk-fix a CAT I across the estate.**
*Bulk Remediation* → severity = **high** → select the affected findings → tick the authorisation checkbox → **Push remediation**. Each machine's job appears in the *Recent jobs* table with status updates.

**6. Roll back a scan/remediation.**
The audit log preserves before/after state; the *Machine* detail page exposes a **Revert** button on remediation jobs that have a captured DSC compiled MOF.

---

## Is this an "all-in-one" yet?

**~95%.** Items 1–5 of the original roadmap shipped in the v0.2 release. Honest gap analysis below.

### ✅ Already integrated (no other tool needed for these)

- Azure-native CSPM ingestion (Policy + Defender + Resource Graph + ARM)
- Azure Arc for non-Azure hosts (Windows, Linux, on-prem, AWS, GCP)
- Host-level STIG scanning (PowerSTIG for Windows, OpenSCAP for Linux) via Guest Configuration
- DISA SCAP Compliance Checker (SCC) result parsing
- POA&M lifecycle, exceptions, audit trail, RMF mapping
- `.ckl` / `.cklb` / JSON / CSV exports compatible with STIG Viewer 3 and eMASS
- Multi-tenant + multi-subscription rollup with executive dashboard
- Sovereign cloud support (Commercial / US Gov / DoD)
- **eMASS direct push** — v3 REST + DoD PKI mTLS, push POA&Ms and CKLB checklists from the **eMASS Sync** page
- **Scheduled scanning + drift alerts** — Azure Functions timer (`scheduledScan` 06:00 UTC; `complianceDriftCheck` every 6 h → Teams webhook)
- **SIEM forwarding** — Log Analytics workspace + diagnostic settings on backend / frontend / Function App / Key Vault, ready for Sentinel/Splunk pull
- **Vulnerability (CVE) ingestion** — Microsoft Defender Vulnerability Management sub-assessments rendered on the **Vulnerabilities** page with severity, CVSS, exploit availability, inline status
- **Bulk remediation** — multi-select open findings across machines, approval gate, batched DSC/PowerSTIG job submission

### ⚠️ Still gaps

| Gap | Status | What's needed |
|---|---|---|
| **Network device STIGs** (Cisco IOS, F5, etc.) | Not in scope | SSH-based scanners via Azure Automation hybrid worker |
| **Container image STIG scanning** | Not started | Defender for Containers ingestion + ACR webhook |
| **cATO body-of-evidence pack** | Not started | DOCX/PDF templated SSP/SAR/POA&M generator |
| **Hardware/firmware compliance** | Out of cloud-native scope | Keep ACAS/Tenable for this |
| **Multi-tenant SSO across customer tenants** (MSP) | Single-tenant Entra design today | Multi-tenant app reg + per-tenant data isolation |

### Remaining roadmap (in priority order)

1. ~~eMASS REST connector~~ — **shipped**
2. ~~Scheduled scanning + alerting~~ — **shipped**
3. ~~SIEM diagnostic setting~~ — **shipped**
4. ~~Vulnerability ingestion from MDC Servers Plan 2~~ — **shipped**
5. ~~Bulk remediation UI~~ — **shipped**
6. **Container & ACR image STIG scanning** (~2 weeks) — add Defender for Containers ingestion.
7. **cATO evidence pack generator** (~1 week) — DOCX/PDF templates for SSP/SAR/POA&M.

Completing items 6–7 brings this to **true single-pane-of-glass parity** with commercial CSPM+VM+STIG suites.

---

## Azure AD app registration

You need **two** app registrations: one for the backend API and one for the frontend SPA.

### 1 — Backend API registration

```
Azure Portal > Microsoft Entra ID > App registrations > New registration
  Name:                   azure-stig-dashboard-api
  Supported account types: Accounts in this organisational directory only
  Redirect URI:           (leave blank)
```

After creation:
1. **Expose an API** > Set App ID URI to `api://<APPLICATION_CLIENT_ID>`
2. **Add a scope**: `access_as_user` (Admins and users, consent display name of your choice)
3. **App roles** > Create roles:
   | Role | Value | Description |
   |------|-------|-------------|
   | Admin | `admin` | Full access |
   | Operator | `operator` | Trigger scans, edit findings |
   | Auditor | `auditor` | Read-only + export |
4. **Certificates & secrets** > New client secret — copy the value immediately.

Record:
- `AZURE_TENANT_ID` — Entra ID > Overview > Tenant ID
- `AZURE_CLIENT_ID` — this app registration's Application (client) ID
- `AZURE_CLIENT_SECRET` — the secret value from step 4

### 2 — Frontend SPA registration

```
Azure Portal > Microsoft Entra ID > App registrations > New registration
  Name:                   azure-stig-dashboard-spa
  Supported account types: Accounts in this organisational directory only
  Redirect URI:           Single-page application → https://<YOUR_FRONTEND_URL>
```

After creation:
1. **Authentication** > Add redirect URI for local dev: `http://localhost:5173`
2. Enable **Access tokens** and **ID tokens** under implicit grant (SPA flow does not need these, but leave default).
3. **API permissions** > Add permission > My APIs > `azure-stig-dashboard-api` > `access_as_user` — Grant admin consent.

Record:
- `VITE_AZURE_CLIENT_ID` — this SPA registration's Application (client) ID

### 3 — Assign app roles to users / groups

Entra ID > Enterprise applications > `azure-stig-dashboard-api` > Users and groups > Add user/group > Select role.

---

## GitHub Secrets configuration

Add the following secrets to your repository (**Settings > Secrets and variables > Actions**):

| Secret | Description |
|--------|-------------|
| `AZURE_CREDENTIALS` | Output of `az ad sp create-for-rbac --sdk-auth --role contributor --scopes /subscriptions/<SUB_ID>` |
| `AZURE_BACKEND_APP_NAME` | App Service name for the backend (from the ARM deployment output) |
| `AZURE_FRONTEND_APP_NAME` | App Service name for the frontend |
| `AZURE_CONTAINER_REGISTRY` | ACR login server, e.g. `myregistry.azurecr.io` |
| `ACR_USERNAME` | ACR admin username (ACR > Access keys) |
| `ACR_PASSWORD` | ACR admin password |
| `VITE_AZURE_CLIENT_ID` | Frontend SPA client ID (embedded at build time) |
| `VITE_AZURE_TENANT_ID` | Azure AD tenant ID |
| `VITE_API_SCOPE` | `api://<BACKEND_CLIENT_ID>/access_as_user` |

---

## Local development — real Azure data

```bash
# Authenticate with Azure (uses DefaultAzureCredential → AzureCliCredential)
az login

# Backend .env — disable mock mode and set real credentials
cat > backend/.env <<EOF
NODE_ENV=development
MOCK_MODE=false
PORT=3001
AZURE_TENANT_ID=<your-tenant-id>
AZURE_CLIENT_ID=<backend-client-id>
AZURE_CLIENT_SECRET=<backend-client-secret>
DATABASE_URL=postgresql://stiguser:changeme@localhost:5432/stigdb
FRONTEND_URL=http://localhost:5173
LOG_LEVEL=debug
AZURE_SUBSCRIPTION_IDS=<sub1-id>,<sub2-id>
EOF

# Start local PostgreSQL (Docker)
docker run -d --name stig-postgres \
  -e POSTGRES_USER=stiguser \
  -e POSTGRES_PASSWORD=changeme \
  -e POSTGRES_DB=stigdb \
  -p 5432:5432 postgres:16-alpine

# Run TypeORM migrations
cd backend && npm run migration:run

# Start backend
npm run dev

# Frontend .env
cat > frontend/.env <<EOF
VITE_AZURE_CLIENT_ID=<spa-client-id>
VITE_AZURE_TENANT_ID=<your-tenant-id>
VITE_API_SCOPE=api://<backend-client-id>/access_as_user
VITE_MOCK_MODE=false
EOF

# Start frontend
cd frontend && npm run dev
```

---

## Database migrations

> Migrations now run **automatically** on backend startup in production. Set `SKIP_AUTO_MIGRATIONS=true` to disable. The commands below are still useful for local dev.

```bash
cd backend

# Generate migration from entity changes
npm run migration:generate -- src/database/migrations/MyMigration

# Run pending migrations
npm run migration:run

# Revert last migration
npm run migration:revert
```

---

## Running tests

```bash
# Unit + integration tests (MOCK_MODE automatically set by jest setup)
cd backend && npm test

# Frontend component tests
cd frontend && npm test

# E2E tests (requires Docker Compose stack running on localhost)
docker compose up -d
cd e2e && npm test
```

---

## Project structure

```
azure-stig-dashboard/
├── backend/
│   ├── src/
│   │   ├── connectors/          # Azure SDK connectors + ScanOrchestrator
│   │   ├── database/            # TypeORM DataSource, entities, mockSeed
│   │   ├── exporters/           # CKL / JSON / CSV exporter
│   │   ├── middleware/          # auth.ts (JWT RBAC), errorHandler.ts
│   │   ├── models/              # 13 TypeORM entity classes
│   │   ├── routes/              # Express routers (machines, scan, export, …)
│   │   ├── utils/               # Winston logger
│   │   └── index.ts             # App entry point
│   ├── openapi.yaml             # OpenAPI 3.0 spec
│   ├── Dockerfile
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── auth/                # MSAL configuration
│   │   ├── components/          # NavBar, ComplianceDonut, ComplianceBadge
│   │   ├── hooks/               # useApi (Axios + token injection)
│   │   ├── pages/               # Dashboard, Inventory, Machine, Group, Audit
│   │   ├── types/               # Shared TypeScript interfaces
│   │   ├── App.tsx
│   │   └── main.tsx
│   ├── Dockerfile
│   ├── nginx.conf
│   └── package.json
├── e2e/                         # Playwright end-to-end tests
├── infra/
│   ├── main.bicep               # Bicep IaC template
│   └── azuredeploy.json         # ARM JSON for Deploy to Azure button
├── docs/
│   ├── architecture.md
│   ├── data-flow.md
│   ├── example-mapping.json     # Azure Policy/Defender → STIG control mapping
│   └── sample.ckl               # Sample STIG Viewer checklist export
├── .github/workflows/deploy.yml # 3-job CI/CD pipeline
├── docker-compose.yml
├── sample.env                   # Template for .env files
└── package.json                 # npm workspaces root
```

---

## API reference

Interactive Swagger UI is served at `/api/docs` when the backend is running.

Key endpoints:

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | None | Health check |
| GET | `/api/machines` | Any role | Paginated machine list with compliance scores |
| GET | `/api/machines/:id` | Any role | Machine detail with all findings |
| PATCH | `/api/machines/:id/findings/:fid` | operator+ | Update finding status/comments |
| POST | `/api/scan/trigger` | operator+ | Trigger on-demand scan |
| GET | `/api/scan` | Any role | List scans / latest scan status |
| GET | `/api/groups` | Any role | List resource groups |
| GET | `/api/groups/:id/compliance` | Any role | Resource group compliance rollup |
| POST | `/api/export/checklist` | auditor+ | Export .ckl / JSON / CSV |
| GET | `/api/controls` | Any role | List STIG controls |
| GET | `/api/audit` | Any role | Audit log |

Full spec: [backend/openapi.yaml](backend/openapi.yaml)

---

## Export formats

### STIG Viewer Checklist (`.ckl`)

POST `/api/export/checklist` with `{ "machineId": "...", "format": "ckl" }`.

Returns a STIG Viewer-compatible XML file that can be opened directly in **STIG Viewer 3** or imported into **eMASS**.

Status mapping:

| Database value | CKL status |
|---|---|
| `open` | `Open` |
| `not_a_finding` | `NotAFinding` |
| `not_applicable` | `Not_Applicable` |
| `not_reviewed` | `Not_Reviewed` |

See [docs/sample.ckl](docs/sample.ckl) for a complete example.

### JSON / CSV

Same endpoint with `"format": "json"` or `"format": "csv"`. Returns all findings for the machine or resource group as a flat array / spreadsheet.

---

## Contributing

1. Fork and create a feature branch.
2. `npm install` at the repo root to install all workspace dependencies.
3. Run `MOCK_MODE=true npm test` in `backend/` to verify all tests pass.
4. Open a pull request — the GitHub Actions workflow will run lint + tests automatically.

---

## Security

Found a vulnerability? **Do not open a public issue** — use
[private vulnerability reporting](https://github.com/jstan13/azure-stig-dashboard/security/advisories/new).
Full policy, scope, and safe-harbour terms: [SECURITY.md](SECURITY.md).

To verify release signatures and provenance before deploying, see
[docs/verifying-releases.md](docs/verifying-releases.md).

---

## License

MIT — see [LICENSE](LICENSE).
