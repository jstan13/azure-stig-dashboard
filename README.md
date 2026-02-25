# Azure STIG Dashboard (Co-Pilot Generated)

A production-ready full-stack TypeScript dashboard for tracking STIG compliance of Azure workloads. Ingests data from Azure Resource Graph, Azure Policy, Microsoft Defender for Cloud, and ARM, normalises findings against STIG controls, and produces STIG Viewer-compatible `.ckl` exports.

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2FYOUR_ORG%2Fazure-stig-dashboard%2Fmain%2Finfra%2Fazuredeploy.json)

> **Replace `YOUR_ORG`** in the Deploy to Azure button URL with your GitHub organisation or username before publishing the repo.

---

## Table of Contents

1. [Architecture overview](#architecture-overview)
2. [Features](#features)
3. [Quick start — mock mode (no Azure required)](#quick-start--mock-mode)
4. [One-click Deploy to Azure](#one-click-deploy-to-azure)
5. [Azure AD app registration](#azure-ad-app-registration)
6. [GitHub Secrets configuration](#github-secrets-configuration)
7. [Local development — real Azure data](#local-development--real-azure-data)
8. [Database migrations](#database-migrations)
9. [Running tests](#running-tests)
10. [Project structure](#project-structure)
11. [API reference](#api-reference)
12. [Export formats](#export-formats)
13. [Contributing](#contributing)
14. [License](#license)

---

## Architecture overview

```
React (Fluent UI + MSAL.js)
        │  HTTPS + Azure AD JWT
        ▼
Express API (Node 20 / TypeScript)
  ├── Azure Resource Graph connector
  ├── Azure Policy connector
  ├── Defender for Cloud connector
  ├── ARM connector
  └── CKL Exporter (xml2js)
        │
        ▼
PostgreSQL 16 (TypeORM)
        │
Azure AD  ─────────── Auth tokens (frontend + backend JWT validation)
App Insights ────────── Optional telemetry
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

Click the button at the top of this README. The ARM template provisions:

| Resource | SKU / tier |
|---|---|
| App Service Plan | B1 Linux (configurable) |
| Backend App Service | Node 20 LTS |
| Frontend App Service | nginx static |
| PostgreSQL Flexible Server | Burstable B1ms |
| Application Insights | Pay-as-you-go |

**Before deploying** you must:
1. Complete the [Azure AD app registration](#azure-ad-app-registration) steps.
2. Have your Tenant ID and Client IDs ready to paste into the deployment form.

**After deploying** you must:
1. Navigate to the **backend App Service > Identity > System assigned** — note the Object ID.
2. Assign the managed identity the following Azure RBAC roles on each subscription you want to scan:
   - `Reader`
   - `Security Reader`
4. For Azure Arc-connected machines: the Arc agent on each on-premises server connects outbound to Azure — no additional Azure RBAC role is needed to read those resources, but the machine must be enrolled in Azure Arc first (`Microsoft.HybridCompute/machines` resource type). Assign the `Azure Connected Machine Resource Reader` built-in role to the managed identity if you need to query Arc-only resource groups.
5. For Policy data: `Reader` is sufficient for read-only compliance state queries.

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

## License

MIT — see [LICENSE](LICENSE).
