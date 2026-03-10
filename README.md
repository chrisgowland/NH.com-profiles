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

