# Reflection

## What did I build?

A TypeScript/Node command-line tool, `qa-accounts`, that manages an inventory of 15 social-media test accounts (3 each on LinkedIn, Facebook, Instagram, TikTok and X) and checks their health once a day.

- **Inventory** in SQLite with add / update / view / filter / delete / retire, and CSV or JSON import and export.
- **Health-check engine** that records account status, connection status, token validity and expiry, connected assets, permissions, anomalies and a timestamp for every account, and compares what the platform reports against the inventory baseline to catch permission and asset drift.
- **Retry with exponential backoff** for rate limits and timeouts, so a temporary 429 is a warning and not a false failure.
- **Reports**: per-day CSV and JSON, a final JSON report, and a static HTML dashboard showing health by account, platform and day.
- **Issue log** generated from the history: consecutive failing days become one issue with reproduction steps, evidence, likely root cause, severity, next action and the corrective actions taken.
- **Maintenance log** generated from day-over-day changes plus recorded human actions.
- **Alerts** for new problems, with an optional webhook.
- **Audit trail** of who changed which record and when, including old and new values.
- **CI**: one workflow runs type-check and 54 unit tests on every push; a second runs the health check on a daily schedule and commits the reports.

The platforms sit behind one interface (`PlatformClient`). This submission ships a mock implementation driven by a scenario file; a real adapter per platform replaces it without changes to the engine, reports or tests.

## What challenges did I face?

**The brief asks for five calendar days of monitoring and a 72-hour deadline.** Both cannot be true with real time. I chose to be explicit about it and not to backfill data that looks live. Every health-check row carries a `run_mode`: `live` for a check executed on that calendar day, `simulated-clock` for a check executed with an injected date. The dashboard, maintenance log and issue files all state which is which. Day 1 (2026-11-23) is a live run. Later days are simulated-clock runs until their date arrives, at which point the scheduled job replaces them with live results. The actions logged on simulated days are scripted responses, labelled as such.

**Real accounts were not a responsible option.** Creating 15 accounts across five platforms in two days means fake identities and automated sign-ups, which breaks each platform's terms and tends to end in restricted accounts. I used mock accounts, which the brief allows, and put the effort into making the mock layer behave like the failures real test accounts have: expired tokens, revoked scopes, restrictions, invalidated sessions, unlinked Pages, rate limits.

**No Spikerz workspace access.** I could not capture screenshots of the Spikerz connection flow. `docs/connection-workflow.md` documents the manual procedure and how each connection is recorded, with an evidence table ready for screenshots.

**Deciding what "unhealthy" means.** A token that expires in three days and a check that passed on its third attempt are worth knowing about and are not failures. I split anomalies into failing and warning so the pass rate stays meaningful and alerts stay quiet.

**Keeping state without a server.** The scheduled CI job starts from a clean checkout every day. I made the tracked files (seed inventory, recorded actions, daily JSON reports) the source of truth and the SQLite file a rebuildable working copy, so `state rebuild` reconstructs the full history anywhere.

## What would I improve with more time?

1. **Real adapters.** Implement `PlatformClient` against platform-sanctioned test assets, and against the Spikerz API for the connection state as Spikerz sees it. Today the tool checks the platform side only; the most valuable check is whether the two agree.
2. **Run the full five days live** and let the scheduled workflow replace every simulated row.
3. **Automated token refresh** where the platform supports it, with the result written to the maintenance log.
4. **Playwright checks of the Spikerz UI** to confirm each account shows as connected there, with screenshots saved as evidence automatically.
5. **Trend detection**: an account that needs a retry three days in a row should become an issue.
6. **Auto-create tickets** in Jira or Linear from new issues, and close them when the anomaly clears.
7. **Stricter input validation on the CLI** and an end-to-end test of the CLI itself. The unit tests cover the modules, not the command wiring.

## How would this scale from 15 accounts to 100+ accounts?

What already scales:

- The inventory is data, not code. Adding 85 accounts is a CSV import.
- One row per account per day, indexed by account and day. 100 accounts for a year is 36,500 rows, which SQLite handles easily.
- Anomaly codes, severities and recommended actions live in one catalog, so new failure types do not touch the engine.
- Issues group by account and anomaly, so 100 accounts do not mean 100 times the noise.

What I would change:

- **Concurrency with per-platform rate limits.** Checks run one at a time today. At 100+ they need a worker pool with a limit per platform and jitter, because the accounts on one platform share an API quota.
- **Staggered schedules.** Spread checks across the day by platform so one outage does not fail every check at once, and check high-value accounts more often.
- **Postgres instead of SQLite** once several people or jobs write at the same time. The repository layer (`Store`) is the only code that knows about SQL.
- **A secrets manager with one path per account** and scoped access, with rotation tracked in the inventory. Environment variables stop being manageable around a few dozen accounts.
- **Ownership and pools.** Tag accounts by team and purpose, keep standby accounts per platform, and let tests lease an account so two suites do not use the same one at once.
- **Alert routing and thresholds.** Route by owner, and page only when a platform drops below a set share of healthy accounts.
- **Lifecycle automation.** Automatic retirement and replacement requests for accounts restricted beyond a threshold, and a monthly review of unused accounts.
- **A served dashboard** with filters and history in place of the static file.
