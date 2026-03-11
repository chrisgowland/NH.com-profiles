# Nuffield Consultant Review Dashboard

Static website generated from Nuffield consultant profile data.

## Build

```powershell
node scripts/generate-consultant-review.js
```

## Output

- `consultant-review/index.html`
- `consultant-review/orthopaedics-waits.html`
- `consultant-review/data.json`
- `consultant-review/booking-report.csv`

## Publish as a Public Website

This repository is configured for GitHub Pages deploys from Actions.

1. In GitHub, open `Settings` -> `Pages`.
2. Under `Build and deployment`, set `Source` to `GitHub Actions`.
3. Push to `main` (or run the deploy workflow manually) to publish.

Your public URL will be:

`https://<your-github-username>.github.io/NH.com-profiles/`

## Daily Data Refresh

Automated refresh is configured in:

- `.github/workflows/refresh-and-deploy-daily.yml`

Behavior:

- Runs daily at `05:15 UTC` and on manual trigger.
- Regenerates `consultant-review/*` data files.
- Commits updates when data has changed.
- Deploys the refreshed website to GitHub Pages in the same workflow.

## Weekly Snapshot + Email

Workflow:

- `.github/workflows/weekly-refresh-report.yml`

Schedule:

- Every Monday at `08:00 UTC` (cron: `0 8 * * 1`)
- Manual run via `workflow_dispatch`

What it does:

1. Regenerates `consultant-review` outputs.
2. Saves timestamped weekly snapshots in `consultant-review/history/YYYY-MM-DD/`.
3. Commits and pushes updated report files.
4. Sends weekly summary email via Microsoft Graph to `chris.gowland@nuffieldhealth.com`.

Required GitHub Secrets:

- `GRAPH_TENANT_ID`
- `GRAPH_CLIENT_ID`
- `GRAPH_CLIENT_SECRET`
- `GRAPH_SENDER_USER` (mailbox UPN used as sender)

Optional GitHub Variable:

- `REPORT_URL` (published report URL shown in email body)

