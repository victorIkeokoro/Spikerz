# Spikerz QA test-account manager

A TypeScript/Node command-line tool that manages an inventory of 15 social-media test accounts and checks their health every day: account status, connection status, token validity, connected assets and permissions. It writes daily reports, a dashboard, an issue log and a maintenance log.

Take-home submission, Option B (JavaScript/TypeScript).

## Read this first: what is real and what is simulated

| Area | Status |
|---|---|
| The tool, health-check engine, retry logic, reports, tests, CI | Real, working code. 54 unit tests. |
| The 15 accounts | **Mock.** No real social-media accounts were created. |
| The platforms | **Mock.** A scenario file scripts what each "platform" reports on each day. No network calls. |
| Connection to the Spikerz UI | **Manual procedure, documented.** No live Spikerz connection exists behind a mock account, and there are no Spikerz screenshots. |
| The five monitored days (2026-11-23 to 2026-11-27) | Each check row is labelled `live` (executed on that calendar day) or `simulated-clock` (executed with an injected date). Day 1 is live. Days not yet reached at submission time are simulated-clock. |
| Corrective actions on simulated days | Scripted in `data/maintenance-actions.json`, and labelled as such in the maintenance log. |

Why: the brief asks for five calendar days inside a 72-hour deadline, and creating 15 real accounts in that window would mean breaking platform terms. The reasoning is in [REFLECTION.md](REFLECTION.md) and [docs/connection-workflow.md](docs/connection-workflow.md).

## Where each deliverable is

| Deliverable | Location |
|---|---|
| Account inventory (source) | [`data/accounts.seed.csv`](data/accounts.seed.csv) |
| Account inventory (database export) | [`data/exports/`](data/exports/) (CSV and JSON) |
| Five-day health-check reports | [`reports/daily/`](reports/daily/) (CSV and JSON per day) |
| Dashboard | [`reports/dashboard.html`](reports/dashboard.html) (open in a browser) |
| Final report | [`reports/final-report.json`](reports/final-report.json) |
| Five-day maintenance log | [`docs/maintenance-log.md`](docs/maintenance-log.md) |
| Bug reports / issue log | [`docs/issues/`](docs/issues/README.md) |
| Connection workflow and evidence table | [`docs/connection-workflow.md`](docs/connection-workflow.md) |
| Reflection | [`REFLECTION.md`](REFLECTION.md) |

## Setup

Requires Node.js 20 or newer; 22 is what CI uses (`node --version`).

```bash
npm install
cp .env.example .env     # optional; defaults work without it
npm test                 # 54 unit tests
```

## How to run

```bash
# Rebuild the local database from the tracked files (inventory, actions, daily reports)
npm run rebuild

# Run today's health check and regenerate every report
npm run check

# Regenerate the full five-day dataset (keeps any live days, simulates the rest)
npm run generate:5day

# Open the dashboard
open reports/dashboard.html
```

Everything else goes through the CLI. `npm run cli -- --help` lists all commands.

```bash
# Inventory
npm run cli -- account list --platform TikTok --status active
npm run cli -- account view IG-001
npm run cli -- account add --id X-004 --platform X --type profile --cred-ref CRED-X-004 \
    --assets "x:mock_qa_handle_04" --permissions "tweet.read;users.read"
npm run cli -- --actor victor account update X-004 --owner growth-qa --notes "moved team"
npm run cli -- account import --file data/accounts.seed.csv
npm run cli -- account export --format json --out inventory.json
npm run cli -- account retire X-004

# Connection
npm run cli -- account connect X-004 --note "Connected via Spikerz UI" --evidence docs/evidence/X-004.png

# Health checks
npm run cli -- check run                                   # today, all accounts
npm run cli -- check run --account LI-002 FB-003           # selected accounts
npm run cli -- check run --date 2026-11-25                 # another day (recorded as simulated-clock)
npm run cli -- check history --account LI-002
npm run cli -- check schedule --cron "0 8 * * *"           # long-running scheduler

# Reports, maintenance, audit, credentials
npm run cli -- report all
npm run cli -- maintenance add --account LI-002 --note "Re-authorised, new token issued"
npm run cli -- audit --account LI-002
npm run cli -- creds
```

### Scheduling

Three ways to run the check daily:

1. **GitHub Actions** (`.github/workflows/daily-health-check.yml`): runs at 08:00 UTC, rebuilds state, runs the check and commits the reports. The commit history is the evidence trail, one commit per day.
2. **cron**: `0 8 * * * cd /path/to/repo && npm run check`
3. **Built-in scheduler**: `npm run cli -- check schedule`

## What the health check records

For every non-retired account, once per day:

| Field | Meaning |
|---|---|
| `account_status` | active / restricted / suspended |
| `connection_status` | connected / disconnected / error |
| `token_valid`, `token_expires_at` | Token or session validity |
| `connected_assets` | Assets the platform reports as connected |
| `permissions` | Scopes the platform reports as granted |
| `anomalies`, `message` | Machine-readable codes plus the detail |
| `checked_at`, `check_day` | Timestamp and calendar day |
| `attempts`, `latency_ms` | Retry information |
| `run_mode` | `live` or `simulated-clock` |

Anomaly codes:

| Code | Severity | Fails the check |
|---|---|---|
| `ACCOUNT_SUSPENDED` | critical | yes |
| `ACCOUNT_RESTRICTED` | high | yes |
| `DISCONNECTED` | high | yes |
| `TOKEN_EXPIRED` | high | yes |
| `PERMISSION_MISSING` | medium | yes |
| `ASSET_MISSING` | medium | yes |
| `CHECK_FAILED` (retries exhausted) | medium | yes |
| `TOKEN_EXPIRING_SOON` (7 days or less) | low | no, warning |
| `PERMISSION_UNEXPECTED` | low | no, warning |
| `RETRY_RECOVERED` | low | no, warning |

Each code has a likely cause and a recommended action in `src/anomalies.ts`. Those feed the alerts and the generated issue files.

## Data model

SQLite, three tables (`src/db.ts`).

**`accounts`**: one row per test account.

| Column | Notes |
|---|---|
| `account_id` | Primary key, for example `IG-001` |
| `platform` | LinkedIn, Facebook, Instagram, TikTok, X |
| `account_type` | profile, page, business, creator |
| `environment` | for example `qa` |
| `owner` | Owning person or team |
| `status` | active, restricted, suspended, retired |
| `connection_status` | connected, disconnected, pending, error |
| `connected_assets` | **Expected** assets (the baseline) |
| `permissions` | **Expected** permissions (the baseline) |
| `last_health_check` | Timestamp of the latest check |
| `notes` | Free text |
| `credential_ref_id` | Pointer to the secret, never the secret |

**`health_checks`**: one row per account per day (unique on `account_id, check_day`), with the fields listed in the previous section. Re-running a day replaces that day's row.

**`audit_log`**: `account_id, action, actor, at, detail`. Actions: create, update, delete, import, retire, connect, maintenance, health_check. Updates record old and new values.

Two design decisions:

- **Baseline and observation are separate.** `accounts.permissions` and `accounts.connected_assets` hold what should be there. Each health check stores what the platform reported. Drift is the difference, so a missing permission is reported every day until it is fixed, and the baseline changes only when a person changes it.
- **Tracked files are the source of truth; the database is a working copy.** `data/accounts.seed.csv`, `data/maintenance-actions.json` and `reports/daily/*.json` are committed. `data/qa.db` is git-ignored and rebuilt with `npm run rebuild`. A fresh clone or a CI runner gets the full history without a database server.

### Architecture

```
src/
  cli.ts          commands
  store.ts        accounts, health checks, audit (the only SQL)
  importer.ts     CSV / JSON import and export
  platform.ts     PlatformClient interface + MockPlatformClient
  healthcheck.ts  evaluate against baseline, retry, persist
  anomalies.ts    anomaly catalog: severity, cause, action
  alerts.ts       alerts, new-since-yesterday, webhook
  issues.ts       issues derived from history, markdown bug reports
  reports.ts      daily report, final report, maintenance log, dashboard
  artifacts.ts    file output, recorded actions, state rebuild
  credentials.ts  credential reference -> environment variable
  scheduler.ts    cron scheduler
data/
  accounts.seed.csv         the 15 accounts
  mock-scenarios.json       what the mock platforms do on which day
  maintenance-actions.json  recorded connections and corrective actions
```

`PlatformClient` is the boundary to the outside world. Replacing `MockPlatformClient` with real adapters does not change the engine, the reports or the tests.

## Security approach

- **No secrets in the repository, the database or the reports.** The inventory holds a credential reference ID such as `CRED-LI-001`. The secret is read at runtime from the environment variable `QA_CRED_LI_001`, which a secrets manager or GitHub Actions secrets would supply.
- **The importer rejects inventories with secret columns.** A file with a `password`, `token`, `secret` or `cookie` column fails with an explanation.
- **`creds` shows whether a secret is present and never prints it.**
- `.env` is git-ignored. `.env.example` has empty values.
- **No passwords are typed, stored or automated.** Connection is done by a person through the platform's own consent screen.
- **Platform policy.** No real accounts were created, no logins automated, no CAPTCHA or bot detection bypassed, nothing scraped. Checks use data a real integration would get from official APIs.
- **Audit trail.** Every change to an account record stores the actor, the time and the old and new values. Set the actor with `--actor` or `QA_ACTOR`.
- **Least privilege.** A permission that is granted but not in the baseline raises `PERMISSION_UNEXPECTED`.
- Dashboard output is HTML-escaped. `npm audit` reports 0 vulnerabilities at the time of writing.

## Optional additions included

- Retry with exponential backoff for temporary failures
- Alerts for disconnects, expiring tokens and permission changes, with optional webhook
- Dashboard showing health by account, platform and day
- Audit trail of who changed a record and when
- Account retirement workflow
- CI workflow that runs tests and produces the report, plus a scheduled daily health-check workflow

## What the five days show

| Day | Date | What happened |
|---|---|---|
| 1 | 2026-11-23 | All 15 healthy |
| 2 | 2026-11-24 | FB-003 lost `pages_manage_posts`. X-003 rate-limited twice, recovered on the third attempt (warning) |
| 3 | 2026-11-25 | LI-002 token expired. TT-002 restricted. FB-003 still missing the permission |
| 4 | 2026-11-26 | LI-002 and FB-003 recovered. IG-001 disconnected. LI-003 token expiring in 3 days (warning) |
| 5 | 2026-11-27 | IG-001 recovered. FB-002 lost its Page asset. TT-002 still restricted |

Five issues were raised: three resolved, two open at the end (TT-002 restriction, FB-002 missing asset). Details are in [`docs/issues/`](docs/issues/README.md).

## Assumptions and limitations

- Accounts and platforms are mocked. The tool has not been run against real platform APIs or the Spikerz API.
- The check looks at the platform side only. It does not verify what the Spikerz UI itself shows for a connection.
- No Spikerz screenshots or recordings are included, because I had no workspace access and the accounts are mock.
- Days after the submission date are simulated-clock runs until the scheduled job replaces them.
- One check per account per day. Re-running a day overwrites that day's row.
- Checks run one at a time, which is fine for 15 accounts. See the scaling section in the reflection.
- Dates are UTC.
- The unit tests cover the modules. The CLI command wiring is checked by hand, not by automated tests.
- Token refresh is recorded as a manual action. The tool does not refresh tokens.

## Tests

```bash
npm test          # unit tests
npm run typecheck # strict TypeScript
```

54 tests across the store, importer, credentials, health-check engine (anomaly detection, retry, re-run behaviour), mock scenarios, reports, alerts, issues and state rebuild.
