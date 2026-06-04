# Scheduled scan & drift alert functions

This Function App ships alongside the dashboard. It runs two timer-triggered
functions that turn the manual `POST /api/scan/trigger` workflow into an
unattended schedule and a Teams alert pipeline.

| Function | Schedule (UTC) | What it does |
|---|---|---|
| `scheduledScan`         | `0 0 6 * * *` (06:00 daily) | Calls `/api/scan/trigger`, `/api/vulnerabilities/sync`, `/api/compliance-history/snapshot` on the backend (skips outside business hours when enabled) |
| `complianceDriftCheck`  | `0 0 */6 * * *` (every 6 h) | Reads `/api/hierarchy/kpis` and `/api/vulnerabilities/summary`; posts to Teams if CAT I open or critical/exploitable CVEs > threshold (skips outside business hours when enabled) |
| `businessHoursAutoStart` | `%BUSINESS_HOURS_START_CRON%` | Starts PostgreSQL, backend app, and frontend app before business hours |
| `businessHoursAutoShutdown` | `%BUSINESS_HOURS_STOP_CRON%` | Stops backend app, frontend app, and PostgreSQL outside business hours |

## Configuration (App Settings)

| Setting | Required | Description |
|---|---|---|
| `BACKEND_BASE_URL`         | yes | e.g. `https://stigdash-api.azurewebsites.net` |
| `BACKEND_API_AUDIENCE`     | yes (prod) | App ID URI of the backend API registration, e.g. `api://<backend-client-id>` |
| `FUNCTION_API_KEY`         | dev only | Static header used instead of MI token (NOT recommended for prod) |
| `TEAMS_WEBHOOK_URL`        | optional | Incoming-webhook URL for Microsoft Teams |
| `DRIFT_CAT1_THRESHOLD`     | optional | CAT I open count that triggers an alert (default `0`) |
| `BUSINESS_HOURS_MODE`      | optional | `true` enables business-hours gating for scheduled jobs |
| `BUSINESS_HOURS_TIME_ZONE` | optional | IANA timezone for gating, e.g. `UTC` or `America/New_York` |
| `BUSINESS_HOURS_START_HOUR` | optional | Start hour (0-23, inclusive) in `BUSINESS_HOURS_TIME_ZONE` |
| `BUSINESS_HOURS_END_HOUR`   | optional | End hour (0-23, exclusive) in `BUSINESS_HOURS_TIME_ZONE` |
| `BUSINESS_HOURS_AUTO_SHUTDOWN` | optional | `true` enables scheduled start/stop of app + DB outside business hours |
| `BUSINESS_HOURS_START_CRON` | optional | UTC NCRONTAB for startup timer (default `0 45 7 * * 1-5`) |
| `BUSINESS_HOURS_STOP_CRON`  | optional | UTC NCRONTAB for shutdown timer (default `0 15 18 * * 1-5`) |

Grant the Function App's system-assigned managed identity:

- **operator** role on the backend API registration (so `/scan/trigger`, `/vulnerabilities/sync` accept the call).
- Optional: `Reader` on each subscription if you wire additional ARG/ARM queries here.
- If `BUSINESS_HOURS_AUTO_SHUTDOWN=true`, it also needs RBAC rights to start/stop the backend/frontend App Services and PostgreSQL Flexible Server. The Bicep template grants a least-privilege custom role automatically.

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
