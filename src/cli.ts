#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { userInfo } from "node:os";
import { writeFileSync } from "node:fs";
import { buildAlerts, formatAlert, sendAlerts } from "./alerts.js";
import { healthState } from "./anomalies.js";
import {
  DEFAULT_PATHS,
  appendAction,
  applyAction,
  rebuildState,
  writeDailyReports,
  writeSummaryArtifacts,
  type RecordedAction,
} from "./artifacts.js";
import { credentialStatus } from "./credentials.js";
import { openDb } from "./db.js";
import { runHealthCheck, todayUtc } from "./healthcheck.js";
import { accountsToCsv, importFile } from "./importer.js";
import { MockPlatformClient, loadScenarios } from "./platform.js";
import { scheduleDaily } from "./scheduler.js";
import { Store, ValidationError } from "./store.js";
import type { Account } from "./types.js";

const DB_PATH = process.env.QA_DB_PATH ?? "./data/qa.db";
const SCENARIOS = process.env.QA_SCENARIOS ?? "data/mock-scenarios.json";
const ENVIRONMENT = process.env.QA_ENVIRONMENT ?? "qa";

function defaultActor(): string {
  if (process.env.QA_ACTOR) return process.env.QA_ACTOR;
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

const store = () => new Store(openDb(DB_PATH));
const list = (v?: string): string[] =>
  (v ?? "")
    .split(/[;,]/)
    .map((x) => x.trim())
    .filter(Boolean);

function printAccounts(accounts: Account[]): void {
  console.table(
    accounts.map((a) => ({
      id: a.account_id,
      platform: a.platform,
      type: a.account_type,
      env: a.environment,
      status: a.status,
      connection: a.connection_status,
      last_check: a.last_health_check ?? "-",
      cred_ref: a.credential_ref_id,
    }))
  );
}

async function runCheck(opts: { date?: string; account?: string[]; reports: boolean }): Promise<void> {
  const s = store();
  if (s.count() === 0) throw new ValidationError("inventory is empty - run `account import` or `state rebuild` first");
  const client = new MockPlatformClient(loadScenarios(SCENARIOS));
  const simulated = Boolean(opts.date) && opts.date !== todayUtc();
  const day = opts.date ?? todayUtc();
  const summary = await runHealthCheck(s, client, {
    day,
    runMode: simulated ? "simulated-clock" : "live",
    // A simulated-clock run stamps noon UTC of the simulated day and does not wait between retries.
    now: simulated ? () => new Date(`${day}T12:00:00.000Z`) : undefined,
    sleep: simulated ? async () => {} : undefined,
    accountIds: opts.account,
  });
  console.log(
    `Health check ${summary.day} (${summary.run_mode}): ${summary.total} checked - ` +
      `${summary.healthy} healthy, ${summary.warning} warning, ${summary.failing} failing`
  );
  console.table(
    summary.results.map((r) => ({
      account: r.account_id,
      health: healthState(r.anomalies),
      connection: r.connection_status,
      token_valid: r.token_valid,
      attempts: r.attempts,
      anomalies: r.anomalies.join(", ") || "-",
    }))
  );
  const prevDay = s.checkDays().filter((d) => d < day).pop();
  const alerts = buildAlerts(summary.results, s.list(), prevDay ? s.healthChecks({ day: prevDay }) : []);
  for (const a of alerts) console.log(formatAlert(a));
  const sent = await sendAlerts(alerts, process.env.QA_ALERT_WEBHOOK_URL);
  if (sent) console.log(`${sent} alert(s) sent to webhook`);
  if (opts.reports) {
    const files = [...writeDailyReports(s, day), ...writeSummaryArtifacts(s)];
    console.log(`Wrote ${files.length} report file(s) under reports/ and docs/`);
  }
}

const program = new Command();
program
  .name("qa-accounts")
  .description("Manage and monitor a controlled set of social-media QA test accounts")
  .option("--actor <name>", "who is making the change (recorded in the audit trail)", defaultActor());

const actor = (): string => program.opts<{ actor: string }>().actor;

// ----- account ---------------------------------------------------------------
const account = program.command("account").description("Account inventory (CRUD, import, export)");

account
  .command("add")
  .requiredOption("--id <id>")
  .requiredOption("--platform <platform>", "LinkedIn | Facebook | Instagram | TikTok | X")
  .requiredOption("--cred-ref <ref>", "credential reference ID, e.g. CRED-LI-004 (never the secret itself)")
  .option("--type <type>", "profile | page | business | creator", "profile")
  .option("--env <env>", "environment", ENVIRONMENT)
  .option("--owner <owner>", "owner / team", "qa-team")
  .option("--status <status>", "active | restricted | suspended | retired", "active")
  .option("--connection <status>", "connected | disconnected | pending | error", "pending")
  .option("--assets <list>", "expected connected assets, separated by ;")
  .option("--permissions <list>", "expected permissions, separated by ;")
  .option("--notes <text>", "", "")
  .action((o) => {
    const s = store();
    if (s.get(o.id)) throw new ValidationError(`account ${o.id} already exists - use \`account update\``);
    s.upsert(
      {
        account_id: o.id,
        platform: o.platform,
        account_type: o.type,
        environment: o.env,
        owner: o.owner,
        status: o.status,
        connection_status: o.connection,
        connected_assets: list(o.assets),
        permissions: list(o.permissions),
        last_health_check: null,
        notes: o.notes,
        credential_ref_id: o.credRef,
      },
      actor()
    );
    console.log(`Created ${o.id}`);
  });

account
  .command("update <id>")
  .option("--type <type>")
  .option("--env <env>")
  .option("--owner <owner>")
  .option("--status <status>")
  .option("--connection <status>")
  .option("--assets <list>")
  .option("--permissions <list>")
  .option("--notes <text>")
  .option("--cred-ref <ref>")
  .action((id: string, o) => {
    const patch: Partial<Account> = {};
    if (o.type) patch.account_type = o.type;
    if (o.env) patch.environment = o.env;
    if (o.owner) patch.owner = o.owner;
    if (o.status) patch.status = o.status;
    if (o.connection) patch.connection_status = o.connection;
    if (o.assets !== undefined) patch.connected_assets = list(o.assets);
    if (o.permissions !== undefined) patch.permissions = list(o.permissions);
    if (o.notes !== undefined) patch.notes = o.notes;
    if (o.credRef) patch.credential_ref_id = o.credRef;
    store().update(id, patch, actor());
    console.log(`Updated ${id}`);
  });

account.command("view <id>").action((id: string) => {
  const a = store().get(id);
  if (!a) throw new ValidationError(`account ${id} not found`);
  console.log(JSON.stringify(a, null, 2));
});

account
  .command("list")
  .option("--platform <platform>")
  .option("--status <status>")
  .option("--connection <status>")
  .option("--env <env>")
  .option("--json", "print JSON instead of a table")
  .action((o) => {
    const accounts = store().list({
      platform: o.platform,
      status: o.status,
      connection_status: o.connection,
      environment: o.env,
    });
    if (o.json) console.log(JSON.stringify(accounts, null, 2));
    else printAccounts(accounts);
    console.log(`${accounts.length} account(s)`);
  });

account
  .command("import")
  .requiredOption("--file <path>", "CSV or JSON inventory file")
  .option("--reset", "clear the database before importing")
  .action((o) => {
    const s = store();
    if (o.reset) s.reset();
    const r = importFile(s, o.file, actor());
    console.log(`Imported: ${r.created} created, ${r.updated} updated, ${r.failed.length} failed`);
    for (const f of r.failed) console.error(`  ${f.account_id}: ${f.error}`);
    if (r.failed.length) process.exitCode = 1;
  });

account
  .command("export")
  .option("--format <format>", "csv | json", "csv")
  .option("--out <path>", "write to a file instead of stdout")
  .action((o) => {
    const accounts = store().list();
    const text = o.format === "json" ? JSON.stringify(accounts, null, 2) + "\n" : accountsToCsv(accounts);
    if (o.out) writeFileSync(o.out, text);
    else process.stdout.write(text);
  });

account
  .command("connect <id>")
  .description("Record that an account completed the Spikerz UI connection workflow")
  .requiredOption("--note <text>", "what was done")
  .option("--evidence <path>", "screenshot / recording path")
  .option("--date <YYYY-MM-DD>", "day the connection was made", todayUtc())
  .action((id: string, o) => {
    const action: RecordedAction = {
      day: o.date,
      account_id: id,
      kind: "connect",
      actor: actor(),
      detail: o.note,
      evidence: o.evidence,
    };
    applyAction(store(), action);
    appendAction(DEFAULT_PATHS.actions, action);
    console.log(`${id} marked connected`);
  });

account
  .command("retire <id>")
  .description("Retirement workflow: mark retired + disconnected, keep history, stop checking")
  .action((id: string) => {
    store().retire(id, actor());
    console.log(`${id} retired. Remaining manual steps: disconnect it in the Spikerz UI, revoke the app grant on the platform, delete its secret from the secrets manager.`);
  });

account.command("delete <id>").action((id: string) => {
  console.log(store().delete(id, actor()) ? `Deleted ${id}` : `${id} not found`);
});

// ----- check -----------------------------------------------------------------
const check = program.command("check").description("Health checks");

check
  .command("run")
  .description("Run the health check for every non-retired account and write reports")
  .option("--date <YYYY-MM-DD>", "run for a specific day (a day other than today is recorded as simulated-clock)")
  .option("--account <id...>", "limit to specific accounts")
  .option("--no-reports", "do not regenerate report files")
  .action((o) => runCheck(o));

check
  .command("history")
  .option("--account <id>")
  .option("--date <YYYY-MM-DD>")
  .action((o) => {
    console.log(JSON.stringify(store().healthChecks({ accountId: o.account, day: o.date }), null, 2));
  });

check
  .command("schedule")
  .description("Stay running and execute the health check on a cron schedule")
  .option("--cron <expr>", "cron expression (UTC)", "0 8 * * *")
  .action((o) => scheduleDaily(o.cron, () => runCheck({ reports: true })));

// ----- report ----------------------------------------------------------------
const report = program.command("report").description("Reports");

report
  .command("daily")
  .option("--date <YYYY-MM-DD>", "day to report", todayUtc())
  .action((o) => writeDailyReports(store(), o.date).forEach((f) => console.log(f)));

report
  .command("all")
  .description("Regenerate every daily report plus dashboard, final report, issues, maintenance log, inventory export")
  .action(() => {
    const s = store();
    const files = [...s.checkDays().flatMap((d) => writeDailyReports(s, d)), ...writeSummaryArtifacts(s)];
    files.forEach((f) => console.log(f));
  });

// ----- maintenance -----------------------------------------------------------
program
  .command("maintenance")
  .description("Maintenance log")
  .command("add")
  .requiredOption("--account <id>")
  .requiredOption("--note <text>", "corrective action taken")
  .option("--date <YYYY-MM-DD>", "", todayUtc())
  .action((o) => {
    const s = store();
    if (!s.get(o.account)) throw new ValidationError(`account ${o.account} not found`);
    const action: RecordedAction = { day: o.date, account_id: o.account, kind: "maintenance", actor: actor(), detail: o.note };
    applyAction(s, action);
    appendAction(DEFAULT_PATHS.actions, action);
    console.log("Recorded. Run `report all` to refresh the maintenance log.");
  });

// ----- creds / audit / state ---------------------------------------------------
program
  .command("creds")
  .description("Show which credential references resolve to a secret in the environment (values are never printed)")
  .action(() => {
    console.table(
      store()
        .list()
        .map((a) => {
          const c = credentialStatus(a.credential_ref_id);
          return { account: a.account_id, cred_ref: c.refId, env_var: c.envVar, secret_present: c.present };
        })
    );
  });

program
  .command("audit")
  .description("Audit trail: who changed what, and when")
  .option("--account <id>")
  .action((o) => console.table(store().auditTrail(o.account)));

program
  .command("state")
  .description("Database state")
  .command("rebuild")
  .description("Rebuild the SQLite database from the tracked files (seed, recorded actions, daily JSON reports)")
  .action(() => {
    const r = rebuildState(store());
    console.log(`Rebuilt: ${r.accounts} accounts, ${r.actions} recorded actions, ${r.checks} health-check rows`);
  });

program.parseAsync().catch((err: Error) => {
  console.error(err instanceof ValidationError ? `Error: ${err.message}` : err);
  process.exit(1);
});
