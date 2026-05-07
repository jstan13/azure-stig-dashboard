# Quickstart — Azure STIG Dashboard (Mock Mode)

This quickstart gets you to a fully working dashboard with seeded data on a
clean machine in under 5 minutes. No Azure tenant required.

## Prerequisites

- Docker Desktop (or Docker Engine 24+ with Compose v2) running
- 8 GB RAM available
- A modern browser

That's it.

## 60-second path: Docker Compose

```powershell
git clone https://github.com/jstan13/azure-stig-dashboard.git
cd azure-stig-dashboard
docker compose up --build
```

Then open:
- Frontend: http://localhost
- Backend health: http://localhost:3001/healthz
- API docs: http://localhost:3001/api/docs

You will be signed in automatically as **Demo Admin** because `MOCK_MODE=true`
in `sample.env`. The seeded dataset includes:
- 2 Collections (`prod-boundary-A`, `lab-boundary-B`)
- 12 Assets across Azure VM, Arc machine, AKS, App Service, SQL, Storage,
  Key Vault types
- 3 Benchmark versions (Windows Server 2022 STIG, RHEL 9 STIG, IIS 10 STIG)
  with their full Rule sets loaded from committed XCCDF fixtures
- ~600 Findings across statuses
- 1 Exception (approved), 1 POA&M (Open), 1 Audit-trail demo sequence

### Try the auditor flow (US1)

1. Navigate to **Collections → prod-boundary-A**.
2. Click any asset; review its findings.
3. Click **Export → CKL**. The downloaded `.ckl` opens in DISA STIG Viewer.

### Try the operator flow (US2)

1. From the same Collection, click **Trigger evaluation**.
2. Watch each asset transition `Queued → Evaluating → Evaluated`.
3. New findings appear; the audit trail records the trigger.

### Try the admin flow (US3)

1. **Settings → Roles** — assign yourself `auditor` on Collection B; refresh
   and verify your write actions on Collection B are denied.
2. **Settings → Exceptions** — approve the pending exception; observe affected
   findings flip to `Not_Applicable`.

## Local development (without Docker)

Requires Node.js 20+, PowerShell 7+, and a local Postgres 16
(or use the `docker compose up postgres` service).

```powershell
# Install workspace deps
npm install

# Backend
cd backend
Copy-Item ..\sample.env .env
npm run db:migrate
npm run dev      # ts-node + nodemon on :3001

# Frontend (new terminal)
cd ..\frontend
Copy-Item ..\sample.env .env
npm run dev      # Vite on :5173, proxies /api → :3001
```

Open http://localhost:5173.

## Running the test suite (mock mode)

```powershell
# Unit + integration
npm run test

# Frontend E2E + accessibility (Playwright + axe-core)
npm run test:e2e

# Round-trip CKL fidelity
npm run test:ckl-roundtrip

# Bicep what-if (requires az CLI + a target subscription)
npm run iac:whatif
```

CI runs all of the above on every PR.

## Switching to real Azure data

After completing the Entra app registration steps in the main `README.md`:

1. Create a `.env` from `sample.env` and set:
   ```
   MOCK_MODE=false
   AZURE_TENANT_ID=...
   AZURE_API_CLIENT_ID=...
   AZURE_SPA_CLIENT_ID=...
   AZURE_SUBSCRIPTION_IDS=sub-id-1,sub-id-2
   STIGMAN_INTEGRATION=disabled
   ```
2. Sign in to Azure: `az login --tenant <tenant>`.
3. The backend uses `DefaultAzureCredential`. Locally that resolves to your
   `az` CLI credentials; in Azure it resolves to the App Service's managed
   identity.
4. Grant your developer principal (or the App Service's MI) `Reader`,
   `Security Reader`, and `Azure Connected Machine Resource Reader` on the
   target subscriptions.

## What to read next

- [spec.md](./spec.md) — the user-facing specification
- [plan.md](./plan.md) — architecture, gates, and project structure
- [research.md](./research.md) — design decisions
- [data-model.md](./data-model.md) — entity model and state machines
- [contracts/openapi.yaml](./contracts/openapi.yaml) — REST contract
- `.specify/memory/constitution.md` — non-negotiable principles
