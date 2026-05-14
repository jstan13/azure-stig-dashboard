# Scheduled scan & drift alert functions

This Function App ships alongside the dashboard. It runs two timer-triggered
functions that turn the manual `POST /api/scan/trigger` workflow into an
unattended schedule and a Teams alert pipeline.

| Function | Schedule (UTC) | What it does |
|---|---|---|
| `scheduledScan`         | `0 0 6 * * *` (06:00 daily) | Calls `/api/scan/trigger`, `/api/vulnerabilities/sync`, `/api/compliance-history/snapshot` on the backend |
| `complianceDriftCheck`  | `0 0 */6 * * *` (every 6 h) | Reads `/api/hierarchy/kpis` and `/api/vulnerabilities/summary`; posts to Teams if CAT I open or critical/exploitable CVEs > threshold |

## Configuration (App Settings)

| Setting | Required | Description |
|---|---|---|
| `BACKEND_BASE_URL`         | yes | e.g. `https://stigdash-api.azurewebsites.net` |
| `BACKEND_API_AUDIENCE`     | yes (prod) | App ID URI of the backend API registration, e.g. `api://<backend-client-id>` |
| `FUNCTION_API_KEY`         | dev only | Static header used instead of MI token (NOT recommended for prod) |
| `TEAMS_WEBHOOK_URL`        | optional | Incoming-webhook URL for Microsoft Teams |
| `DRIFT_CAT1_THRESHOLD`     | optional | CAT I open count that triggers an alert (default `0`) |

Grant the Function App's system-assigned managed identity:

- **operator** role on the backend API registration (so `/scan/trigger`, `/vulnerabilities/sync` accept the call).
- Optional: `Reader` on each subscription if you wire additional ARG/ARM queries here.

## Deploy

The Bicep template at [`../infra/main.bicep`](../infra/main.bicep) provisions
the Function App on a Consumption plan if `enableScheduler` is `true` (default).
After `azd up` you can also redeploy this folder alone:

```pwsh
cd functions
npm install
npm run build
func azure functionapp publish <function-app-name>
```
