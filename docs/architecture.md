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
| Auth           | express-jwt + jwks-rsa | Validate Azure AD JWT, enforce RBAC roles |
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
Azure AD Token
  └─ Claims:
       sub   — user object ID
       name  — display name
       email — UPN
       roles — [admin | operator | auditor]   <- custom app roles in manifest

Backend RBAC:
  admin    — all endpoints
  operator — trigger scans, edit findings
  auditor  — read-only, export checklists

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
