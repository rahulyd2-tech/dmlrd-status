# DMLRD status

Status page for DMLRD Group services: **https://status.dmlrd.tech** (sign-in required).

Change records: **CR-2026-0024** (monitoring), **CR-2026-0027** (sign-in, encrypted data). Group SDLC ledger: `rahulyd2-tech/doomwatcher` -> `docs/sdlc/`.

## Why it runs here
The checks and the page run on GitHub, outside our network, so they keep working when our main server is down. This repo is public because that is what makes GitHub Pages and frequent scheduled checks free. Nothing readable about our services is published:

- **Everything in `data/` is encrypted** with AES-256-GCM (`lib/vault.mjs`), including the list of monitored sites (`data/sites.enc`). The one plain file is `data/heartbeat.json`: the time of the last run, so our own server can tell the checks are still running.
- **The page asks for a password.** The password unlocks the data key stored in `kdf.json` (PBKDF2-SHA256, 600,000 rounds) and the page decrypts the data in the browser. Without the password the files are unreadable.
- **Public logs, commit messages and GitHub issues carry no site names or results.** An outage issue only says that something stopped working and links to the page.

## How it works
| Piece | What it does |
|---|---|
| `check.mjs` | Checks every site (answer, speed, security certificate), retries once, records the result encrypted. No outside packages. |
| `.github/workflows/health-check.yml` | Runs the check every 15 minutes and commits the encrypted results. |
| `.github/workflows/publish-page.yml` | Publishes `site/` (and `kdf.json`) to GitHub Pages when they change. The page reads the latest encrypted results from this repo. |
| `data/sites.enc` | The monitored sites and what a healthy answer looks like. |
| `data/latest.enc`, `data/daily.enc` | Current state and per-day counts for the 90-day bars. |
| `data/runs/YYYY-MM-DD.enc` | One line per check run (the raw record). |
| `data/events.enc` | Every outage and recovery, append-only, SHA-256 hash-chained. |
| `tools/status-tool.mjs` | Admin tool (decrypt/encrypt the site list, change the password, verify the log). |

## Alerts
- A site is marked **down** after **2 failed runs in a row**, to avoid false alarms.
- Every outage opens a GitHub issue labelled `outage` (GitHub emails the owner, without details) and closes it when the service works again.
- **WhatsApp** goes out only when the whole of XTREME2 is unreachable, or for sites not hosted on XTREME2. Single-site problems on XTREME2 are alerted by XTREME2's own monitor.

## Keys and secrets
| Where | What |
|---|---|
| Repository secrets | `STATUS_DATA_KEY` (data key), `WA_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_TO` |
| XTREME2 `D:\monitoring\secrets\status-page.env` | `STATUS_DATA_KEY` and the page password `STATUS_PASSWORD` (folder limited to the owner, SYSTEM, Administrators) |

## Admin tasks (on XTREME2, in this folder, with the env file loaded)
- **Change the password:** set the new `STATUS_PASSWORD` in the env file, run `node tools/status-tool.mjs set-password`, commit `kdf.json`. Devices that stayed signed in are signed out.
- **Change what is monitored:** `node tools/status-tool.mjs sites-decrypt`, edit `sites.json` (never commit it), `node tools/status-tool.mjs sites-encrypt`, commit `data/sites.enc`, under a CR. Then run the Health check workflow by hand twice and confirm the new site passes from GitHub's network (some hosts block it; RCA-2026-005).
- **Check the audit log:** `node tools/status-tool.mjs verify-events`; read it with `node tools/status-tool.mjs show data/events.enc`.

## Limits of the simple sign-in
- One shared password. There are no individual accounts and no record of who looked.
- "Keep me signed in" stores the data key on that device. Changing the password signs every device out of the page. A full revocation (a new data key) re-encrypts the data and is done under a CR.
