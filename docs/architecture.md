# Architecture — Azure STIG Dashboard

## Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser (SPA)                            │
│   React + Fluent UI + MSAL.js + Recharts                        │
│   Routes: /dashboard | /inventory | /machines/:id               │
│           /groups/:id | /audit                                  │
└────────────────────┬────────────────────────────────────────────┘
                     │ HTTPS + Bearer JWT (Azure AD)
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Backend API (Node.js / Express)                 │
│                                                                 │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐    │
│  │ Auth        │  │ REST Routes  │  │ Swagger / OpenAPI   │    │
│  │ (JWT RBAC)  │  │ /api/*       │  │ /api/docs           │    │
│  └─────────────┘  └──────┬───────┘  └─────────────────────┘    │
│                          │                                      │
│  ┌───────────────────────▼───────────────────────────────────┐  │
│  │              Connector Layer                               │  │
│  │  ResourceGraphConnector  · PolicyConnector                 │  │
│  │  DefenderConnector       · ARMConnector                    │  │
│  │  ScanOrchestrator                                         │  │
│  └────────────────────┬──────────────────────────────────────┘  │
│                       │                                         │
│  ┌────────────────────▼──────────────────────────────────────┐  │
│  │            Exporter Layer                                  │  │
│  │  CKL Exporter (xml2js) · JSON/CSV Exporter                │  │
│  └────────────────────┬──────────────────────────────────────┘  │
│                       │                                         │
│  ┌────────────────────▼──────────────────────────────────────┐  │
│  │            Data Layer (TypeORM)                            │  │
│  │  PostgreSQL (prod) · In-memory mock (dev)                  │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                     │
         ┌───────────┴───────────┐
         ▼                       ▼
┌──────────────────┐   ┌─────────────────────────────────┐
│ Azure AD (OIDC)  │   │  Azure Management APIs          │
│ - Auth tokens    │   │  - Resource Graph                │
│ - RBAC roles     │   │  - Azure Policy / Policy States  │
│  admin/operator  │   │  - Defender for Cloud (CSPM)     │
│  /auditor        │   │  - ARM (VM metadata, extensions) │
└──────────────────┘   └─────────────────────────────────┘
```

## Component breakdown

### Frontend (`/frontend`)
| Module         | Technology          | Purpose                              |
|----------------|---------------------|--------------------------------------|
| Auth           | MSAL.js v3          | Azure AD OIDC login, token refresh   |
| Routing        | React Router v6     | Client-side navigation               |
| UI components  | Fluent UI v8        | Forms, tables, panels                |
| Charts         | Recharts            | Compliance donut, bar charts         |
| API client     | Axios               | REST calls to backend, token inject  |
| Build          | Vite 5              | Hot reload, production bundle        |

### Backend (`/backend`)
| Module         | Technology          | Purpose                                      |
|----------------|---------------------|----------------------------------------------|
| HTTP server    | Express 4           | Request handling, middleware                 |
| Auth           | jose (JWKS) + permission engine | Validate Entra JWT, resolve roles, enforce permissions |
| Connectors     | Azure SDK v4+       | Ingest data from Azure APIs                  |
| ORM            | TypeORM 0.3         | Database entities and migrations             |
| Export         | xml2js              | Generate STIG Viewer .ckl XML               |
| Docs           | swagger-ui-express  | OpenAPI 3.0 documentation                   |
| Logging        | Winston             | Structured logs + App Insights              |
| Scheduler      | node-cron           | Periodic full/incremental scans             |

### Infrastructure (`/infra`)
| Template       | Purpose                                      |
|----------------|----------------------------------------------|
| `main.bicep`   | Bicep IaC for Bicep CLI / Azure DevOps       |
| `azuredeploy.json` | ARM JSON for "Deploy to Azure" button   |

Provisioned resources:
- **App Service Plan** (Linux, configurable SKU)
- **App Service** × 2 (backend API + frontend SPA)
- **PostgreSQL Flexible Server** (v16, Burstable)
- **Application Insights** (telemetry)
- **System Managed Identity** on backend (for Azure SDK calls without storing credentials)

## Security model

```
Entra ID Token
  └─ Claims:
       sub    — subject
       oid    — user object ID (stable identity for role bindings)
       name   — display name
       upn    — user principal name
       roles  — Entra app roles [auditor | operator | isso | issm | admin]
       groups — assigned security-group object IDs (ApplicationGroup claim)

Authorization (permission-based, see backend/src/auth/):
  authenticate (middleware/authn.ts)
    └─ validates the token with JwtValidator (auth/jwt.ts) and sets req.principal
  roleResolver (auth/roleResolver.ts)
    └─ merges three role sources into global + per-Collection grants:
         1. Entra app roles            -> global roles
         2. group_role_mappings        -> Entra group object ID -> role
         3. role_bindings              -> per-user, optionally Collection-scoped
  can (auth/can.ts) + permissions catalog (auth/permissions.ts)
    └─ decides each request on a *permission*, not a raw role.

Role -> permission tiers (cumulative; higher tiers inherit lower):
  auditor  — dashboard:read, export:generate, audit:read
  operator — + scan:trigger, findings:write (manual STIG checks),
             remediation:execute, stig:import, emass:push
  isso     — + poam:write, exception:write
  issm     — + poam:approve, exception:approve, remediation:approve,
             roles:assign   (approvals separated from execution for SoD)
  admin    — + collection:manage, users:manage, notifications:manage

Scoping:
  Global grants apply to every ATO boundary. Collection-scoped grants apply
  only within that Collection, so an ISSO on Collection A cannot edit findings
  on Collection B. Tenant-wide permissions (collection:manage, users:manage,
  notifications:manage, audit:read, stig:import) require a *global* grant.

Backend identity (MSI):
  Assigned Reader role on subscriptions at deploy time
  Required API permissions:
    Microsoft.ResourceGraph/resources/read
    Microsoft.Authorization/policyAssignments/read
    Microsoft.Security/assessments/read
    Microsoft.Resources/subscriptions/read
```

## Deployment topology

```
GitHub → GitHub Actions
  └─ npm test (unit + integration)
  └─ npm build (frontend + backend)
  └─ azure/webapps-deploy → Azure App Service
```

One-click deploy creates the full stack; the only manual steps are:
1. Create Azure AD app registration (see README)
2. Assign Managed Identity Reader role on subscription(s) after deploy
