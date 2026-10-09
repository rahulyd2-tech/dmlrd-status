# DMLRD status

Live status page for DMLRD Group websites and apps: **https://status.dmlrd.tech**

Change record: **CR-2026-0024** (group SDLC ledger, `rahulyd2-tech/doomwatcher` -> `docs/sdlc/`).

## Why it lives here and not on our own server
The page and its checks run on GitHub, outside our network. If XTREME2 (our main server) or its internet link goes down, these checks still run, the page still loads and shows the outage, and the alerts still go out.

XTREME2 also runs its own, more detailed monitor (every minute, including internal services). That one sends the per-site alerts and the daily summary email. This repo is the independent outside view.

## How it works
| Piece | What it does |
|---|---|
| `sites.json` | The list of public sites and what a healthy answer looks like. Groups: Websites, RDRCTR, Apps and platforms, and Coming soon (placeholder pages that answer 403/503 on purpose and count as working; shown collapsed). |
| `check.mjs` | Checks every site (answer, speed, security certificate), retries once, and records the result. No outside packages. |
| `.github/workflows/health-check.yml` | Runs the check every 5 minutes and commits the results to `data/`. |
| `.github/workflows/publish-page.yml` | Publishes `site/` to GitHub Pages when the page changes. The page reads live results from `data/`. |
| `data/latest.json` | Current state of every site. |
| `data/daily.json` | Per-day counts for the 90-day bars. |
| `data/runs/YYYY-MM-DD.jsonl` | One line per check run (the raw record). |
| `data/events.jsonl` | Every outage and recovery, append-only, SHA-256 hash-chained. |

## Alerts
- A site is marked **down** after **2 failed runs in a row** (about 10 minutes), to avoid false alarms.
- Every outage opens a **GitHub issue** labelled `outage` (GitHub emails the owner) and closes it when the site works again.
- **WhatsApp** (Meta Cloud API template `dmlrd_site_down` / `dmlrd_site_recovered`) is sent only for:
  - the whole of XTREME2 being unreachable (one message, not one per site), and
  - sites that are not hosted on XTREME2 (GitHub Pages).

dmlrdinternetservices.com (GoDaddy Website Builder) is checked only by XTREME2: GoDaddy cuts connections coming from GitHub's network, so an outside check here would always report it down.
  Single-site problems on XTREME2 are alerted by XTREME2's own monitor, so you are not messaged twice.

## Secrets (repository settings -> Secrets and variables -> Actions)
`WA_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_TO` (comma-separated numbers). Same Meta app as DooMWaTCHeR: rotate both together.

## Checking the audit log
```sh
node -e "const c=require('crypto');let p='0'.repeat(64);for(const l of require('fs').readFileSync('data/events.jsonl','utf8').trim().split('\n')){const o=JSON.parse(l),h=o.hash;delete o.hash;if(o.prev!==p||c.createHash('sha256').update(JSON.stringify(o)).digest('hex')!==h)throw Error('chain broken at '+o.ts);p=h}console.log('chain OK')"
```

## Changing what is monitored
Edit `sites.json` under a CR and test with `node check.mjs --dry-run` (no issues or messages are sent). After committing, run the **Health check** workflow by hand twice and confirm the new site passes **from GitHub's network** - some hosts (e.g. GoDaddy Website Builder) block it (RCA-2026-005, PA1).
