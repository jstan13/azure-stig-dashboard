Create a full‑stack TypeScript project named "azure-stig-dashboard" that implements the following features and artifacts. Produce code, configuration, and documentation so the repo can be deployed from GitHub to Azure with a single click.

1) Project layout and scaffolding
- Monorepo with two packages: /frontend (React + TypeScript + Vite or CRA) and /backend (Node.js + TypeScript + Express or Azure Functions).
- /infra containing ARM or Bicep templates and an `azuredeploy.json` for the GitHub Deploy to Azure button.
- /deploy/github-actions.yml for CI/CD that builds, tests, and deploys to Azure App Service (or Azure Functions) using `azure/webapps-deploy` action.
- Dockerfile for backend and multi‑stage build for frontend.

2) Authentication and security
- Implement Azure AD OIDC login in the frontend using MSAL.js.
- Backend validates JWT tokens and enforces RBAC roles: **admin**, **operator**, **auditor**.
- Provide a script or README steps to create an Azure AD app registration and the minimal API permissions required (read subscriptions, resource graph, security center, policy).

3) Azure ingestion connectors
- Implement modular connectors in the backend to ingest:
  - Azure Resource Graph queries for resource inventory.
  - Azure Policy / Policy State to determine compliance per resource.
  - Microsoft Defender for Cloud / Security Center findings (CSPM).
  - VM/host configuration via Azure Resource Manager and extensions metadata.
- Connectors must support:
  - Full scan across subscriptions (with pagination).
  - Incremental updates (using timestamps or change tokens).
  - On‑demand scan for a single machine or resource group.
- Store raw ingestion results and normalized control mapping in the database.

4) Data model and database
- Design a schema (Postgres or Cosmos DB) with entities:
  - **Subscription**, **ResourceGroup**, **Resource**, **Machine**, **Control**, **ControlMapping**, **Scan**, **Finding**, **Checklist**, **User**, **Role**, **Exception**, **AuditLog**.
- Provide TypeORM or Prisma models and migration scripts.

5) STIG Manager feature parity and STIG Viewer compatibility
- Implement rule mapping layer that maps Azure findings and policy states to STIG controls.
- Provide UI pages and APIs for:
  - Scanning and scheduling scans.
  - Viewing per‑machine compliance summary and control details.
  - Group rollups and aggregated compliance percentages.
  - Creating and managing exceptions and remediation notes.
  - Exporting a machine or group to a STIG Viewer–compatible checklist file (`.ckl`) and JSON/CSV.
- Implement an exporter that generates `.ckl` files with required fields for STIG Viewer compatibility (include mapping template and sample output).

6) Dashboard UI
- Build a responsive React dashboard with:
  - **Overview**: global compliance score, recent scans, top failing controls.
  - **Inventory**: searchable list of machines/resources with compliance badges.
  - **Machine view**: control list, evidence, remediation steps, export button.
  - **Group view**: aggregated controls and bulk export.
  - **Audit & history**: timeline of changes, who exported or modified checklists.
- Use component library (e.g., Fluent UI or Material UI) and provide accessible charts (compliance donut, bar charts).

7) APIs and backend
- RESTful API endpoints (documented via OpenAPI/Swagger):
  - `POST /api/scan/trigger` — trigger scan for subscription/resource group/machine.
  - `GET /api/machines` — list machines with filters.
  - `GET /api/machines/{id}` — machine details and controls.
  - `GET /api/groups/{id}/compliance` — group rollup.
  - `POST /api/export/checklist` — generate and return `.ckl` or JSON.
  - `GET /api/controls` — list controls and mappings.
- Implement pagination, filtering, and role checks.

8) CI/CD and Deploy to Azure
- Add `azuredeploy.json` or `main.bicep` that provisions:
  - App Service (Linux) or Azure Functions.
  - App Service Plan.
  - Azure SQL / Cosmos DB.
  - Application Insights.
  - Managed Identity for the app with Reader role on subscriptions (or instructions to grant).
- Add a `README.md` with a **Deploy to Azure** button snippet and step‑by‑step instructions for:
  - Creating Azure AD app registration and granting API permissions.
  - Setting required app settings (client id, tenant id, DB connection string).
  - How to use the GitHub Deploy button.
- Provide a GitHub Actions workflow that:
  - Builds frontend and backend.
  - Runs unit tests.
  - Pushes Docker images to Azure Container Registry (optional).
  - Deploys to App Service using `azure/webapps-deploy`.

9) Tests and quality
- Add unit tests for backend connectors and exporter logic.
- Add basic E2E test skeleton for the frontend (Playwright or Cypress).
- Add linting and TypeScript strict mode.

10) Documentation and sample data
- Provide a `docs/` folder with:
  - Architecture diagram (textual).
  - Data flow for ingestion → mapping → dashboard → export.
  - Example mapping file that maps Azure Policy IDs and Security Center rule IDs to STIG control IDs.
  - Sample `.ckl` export for a demo machine.
- Include a `sample.env` with all required environment variables and descriptions.

Acceptance criteria (what to generate)
- A runnable repo scaffold with working login, a mock ingestion connector (with sample data) that populates the DB, a dashboard page showing compliance for sample machines, and a working export endpoint that returns a `.ckl` file for a sample machine.
- ARM/Bicep template and GitHub Actions workflow enabling a one‑click deploy flow.
- README with Deploy to Azure button and setup steps.

Implementation notes for Copilot
- Use Azure SDKs (`@azure/arm-resources`, `@azure/arm-security`, `@azure/arm-policy`, `@azure/arm-resourcegraph`) where applicable.
- Use MSAL for frontend auth and `passport-azure-ad` or `express-jwt` for backend token validation.
- Keep secrets out of the repo; use Azure App Settings or GitHub Secrets.
- Provide clear TODOs and placeholders where human input is required (e.g., Azure AD app registration steps, subscription consent).
- Favor modular, testable code and include comments explaining mapping logic and export format.

Produce:
- File and folder scaffolding with key files implemented (frontend login, one dashboard page, backend connectors with a mock data mode, exporter that creates `.ckl` for sample data).
- `README.md` with Deploy to Azure button snippet and setup instructions.
- `azuredeploy.json` or `main.bicep` and `/.github/workflows/deploy.yml`.

End of prompt.
