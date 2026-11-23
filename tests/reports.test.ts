import { describe, expect, it } from "vitest";
import { buildAlerts, notify, sendAlerts } from "../src/alerts.js";
import { runHealthCheck } from "../src/healthcheck.js";
import { parseCsv } from "../src/importer.js";
import { deriveIssues, issueToMarkdown } from "../src/issues.js";
import { MockPlatformClient, type ScenarioEvent } from "../src/platform.js";
import {
  buildDailyReport,
  buildFinalReport,
  buildMaintenanceLog,
  dailyReportToCsv,
  renderDashboard,
} from "../src/reports.js";
import type { Store } from "../src/store.js";
import { account, memoryStore, noSleep } from "./helpers.js";

const DAYS = ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"];
const EVENTS: ScenarioEvent[] = [
  { account_id: "LI-001", from_day: 2, to_day: 3, effect: "token_expired", detail: "401 invalid_token" },
  { account_id: "X-001", from_day: 3, to_day: 4, effect: "restricted" },
  { account_id: "X-001", from_day: 2, to_day: 2, effect: "token_expiring", days_left: 2 },
];

async function seeded(): Promise<Store> {
  const store = memoryStore();
  store.upsert(account());
  store.upsert(account({ account_id: "X-001", platform: "X", credential_ref_id: "CRED-X-001" }));
  const client = new MockPlatformClient({ monitoring_start: DAYS[0]!, events: EVENTS });
  for (const day of DAYS) {
    await runHealthCheck(store, client, { day, sleep: noSleep, runMode: "simulated-clock", now: () => new Date(`${day}T12:00:00Z`) });
  }
  return store;
}

describe("daily report", () => {
  it("summarises one day and lists every account", async () => {
    const report = buildDailyReport(await seeded(), "2026-01-02");
    expect(report.totals).toEqual({ accounts: 2, healthy: 0, warning: 1, failing: 1, not_checked: 0 });
    expect(report.results.map((r) => [r.account_id, r.health])).toEqual([
      ["LI-001", "failing"],
      ["X-001", "warning"],
    ]);
  });

  it("produces a CSV with a header and one row per account", async () => {
    const rows = parseCsv(dailyReportToCsv(buildDailyReport(await seeded(), "2026-01-02")));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("anomalies");
    expect(rows[1]).toContain("TOKEN_EXPIRED");
  });
});

describe("alerts", () => {
  it("marks an anomaly as new only on the first day it appears", async () => {
    const store = await seeded();
    const day2 = buildDailyReport(store, "2026-01-02").alerts.find((a) => a.code === "TOKEN_EXPIRED");
    const day3 = buildDailyReport(store, "2026-01-03").alerts.find((a) => a.code === "TOKEN_EXPIRED");
    expect(day2?.is_new).toBe(true);
    expect(day3?.is_new).toBe(false);
  });

  it("orders alerts by severity", async () => {
    const store = await seeded();
    const alerts = buildAlerts(store.healthChecks({ day: "2026-01-02" }), store.list());
    expect(alerts.map((a) => a.severity)).toEqual(["high", "low"]);
  });

  it("sends only new, non-low alerts to the webhook and nothing without a URL", async () => {
    const store = await seeded();
    const alerts = buildDailyReport(store, "2026-01-02").alerts;
    const posted: string[] = [];
    const post = async (_url: string, body: string) => void posted.push(body);
    expect(await sendAlerts(alerts, undefined, post)).toBe(0);
    expect(await sendAlerts(alerts, "https://hooks.example.test/x", post)).toBe(1);
    expect(posted[0]).toContain("TOKEN_EXPIRED");
    expect(posted[0]).not.toContain("TOKEN_EXPIRING_SOON");
  });
});

describe("alert webhook failures", () => {
  it("reports a failing webhook instead of throwing, so the health check still completes", async () => {
    const store = await seeded();
    const alerts = buildDailyReport(store, "2026-01-02").alerts;
    const failing = async () => {
      throw new Error("alert webhook responded 500");
    };
    await expect(sendAlerts(alerts, "https://hooks.example.test/x", failing)).rejects.toThrow("500");
    expect(await notify(alerts, "https://hooks.example.test/x", failing)).toEqual({ sent: 0, error: "alert webhook responded 500" });
    expect(await notify(alerts, undefined, failing)).toEqual({ sent: 0 });
  });
});

describe("partial runs", () => {
  it("lists the accounts a partial run did not check", async () => {
    const store = memoryStore();
    store.upsert(account());
    store.upsert(account({ account_id: "X-001", platform: "X", credential_ref_id: "CRED-X-001" }));
    store.upsert(account({ account_id: "X-OLD", platform: "X", status: "retired", credential_ref_id: "CRED-X-OLD" }));
    const client = new MockPlatformClient({ monitoring_start: DAYS[0]!, events: [] });
    await runHealthCheck(store, client, { day: DAYS[0]!, sleep: noSleep, accountIds: ["LI-001"] });
    const report = buildDailyReport(store, DAYS[0]!);
    expect(report.totals).toMatchObject({ accounts: 1, not_checked: 1 });
    expect(report.not_checked).toEqual(["X-001"]);
    expect(buildMaintenanceLog(store)).toContain("Partial run: 1 account(s) not checked");
    expect(renderDashboard(buildFinalReport(store))).toContain("No check recorded");
  });
});

describe("issues", () => {
  it("groups consecutive failing days into one issue and tracks resolution", async () => {
    const store = await seeded();
    store.logAction("LI-001", "maintenance", "victor", "re-authorised", "2026-01-03T14:30:00.000Z");
    const issues = deriveIssues(store.healthChecks(), store.list(), store.auditTrail());
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({
      id: "ISS-001",
      account_id: "LI-001",
      code: "TOKEN_EXPIRED",
      first_seen: "2026-01-02",
      last_seen: "2026-01-03",
      days_affected: 2,
      status: "resolved",
      resolved_on: "2026-01-04",
    });
    expect(issues[0]?.corrective_actions.map((a) => a.detail)).toEqual(["re-authorised"]);
    expect(issues[1]).toMatchObject({ account_id: "X-001", code: "ACCOUNT_RESTRICTED", status: "open", resolved_on: null });
  });

  it("keeps a permission issue open when a disconnected day cannot verify it", async () => {
    const store = memoryStore();
    store.upsert(account());
    const client = new MockPlatformClient({
      monitoring_start: DAYS[0]!,
      events: [
        { account_id: "LI-001", from_day: 1, to_day: 1, effect: "permission_removed", value: "write" },
        { account_id: "LI-001", from_day: 2, to_day: 2, effect: "disconnected" },
      ],
    });
    for (const day of DAYS.slice(0, 2)) {
      await runHealthCheck(store, client, { day, sleep: noSleep, runMode: "simulated-clock" });
    }
    const issue = deriveIssues(store.healthChecks(), store.list()).find((i) => i.code === "PERMISSION_MISSING");
    expect(issue).toMatchObject({ status: "open", resolved_on: null, last_seen: DAYS[0] });
  });

  it("keeps an issue open when a failed check cannot verify that it cleared", async () => {
    const store = memoryStore();
    store.upsert(account());
    const client = new MockPlatformClient({
      monitoring_start: DAYS[0]!,
      events: [
        { account_id: "LI-001", from_day: 1, to_day: 1, effect: "token_expired" },
        { account_id: "LI-001", from_day: 2, to_day: 2, effect: "outage" },
      ],
    });
    for (const day of DAYS.slice(0, 2)) {
      await runHealthCheck(store, client, { day, sleep: noSleep, runMode: "simulated-clock" });
    }
    const issue = deriveIssues(store.healthChecks(), store.list()).find((i) => i.code === "TOKEN_EXPIRED");
    expect(issue).toMatchObject({ status: "open", resolved_on: null, last_seen: DAYS[0] });
  });

  it("resolves the issue once a later check can observe the anomaly again and it is gone", async () => {
    const store = memoryStore();
    store.upsert(account());
    const client = new MockPlatformClient({
      monitoring_start: DAYS[0]!,
      events: [
        { account_id: "LI-001", from_day: 1, to_day: 1, effect: "permission_removed", value: "write" },
        { account_id: "LI-001", from_day: 2, to_day: 2, effect: "disconnected" },
      ],
    });
    for (const day of DAYS.slice(0, 3)) {
      await runHealthCheck(store, client, { day, sleep: noSleep, runMode: "simulated-clock" });
    }
    const issue = deriveIssues(store.healthChecks(), store.list()).find((i) => i.code === "PERMISSION_MISSING");
    expect(issue).toMatchObject({ status: "resolved", resolved_on: DAYS[2] });
  });

  it("does not report an unverifiable anomaly as cleared in the maintenance log", async () => {
    const store = memoryStore();
    store.upsert(account());
    const client = new MockPlatformClient({
      monitoring_start: DAYS[0]!,
      events: [
        { account_id: "LI-001", from_day: 1, to_day: 1, effect: "permission_removed", value: "write" },
        { account_id: "LI-001", from_day: 2, to_day: 2, effect: "disconnected" },
      ],
    });
    for (const day of DAYS.slice(0, 3)) {
      await runHealthCheck(store, client, { day, sleep: noSleep, runMode: "simulated-clock" });
    }
    const log = buildMaintenanceLog(store);
    const day2 = log.slice(log.indexOf("## Day 2"), log.indexOf("## Day 3"));
    const day3 = log.slice(log.indexOf("## Day 3"));
    expect(day2).toContain("`PERMISSION_MISSING` not assessable");
    expect(day2).not.toContain("cleared `PERMISSION_MISSING`");
    expect(day3).toContain("cleared `PERMISSION_MISSING`");
  });

  it("does not open issues for warnings", async () => {
    const store = await seeded();
    const codes = deriveIssues(store.healthChecks(), store.list()).map((i) => i.code);
    expect(codes).not.toContain("TOKEN_EXPIRING_SOON");
  });

  it("renders a bug report with repro steps, evidence, root cause, severity and next action", async () => {
    const store = await seeded();
    const md = issueToMarkdown(deriveIssues(store.healthChecks(), store.list())[0]!);
    for (const heading of ["Reproduction steps", "Evidence", "Likely root cause", "Recommended next action", "Severity"]) {
      expect(md).toContain(heading);
    }
    expect(md).toContain("401 invalid_token");
  });
});

describe("final report, maintenance log and dashboard", () => {
  it("aggregates totals across days", async () => {
    const report = buildFinalReport(await seeded());
    expect(report.days).toEqual(DAYS);
    expect(report.totals).toMatchObject({ accounts: 2, days: 4, checks: 8, failing: 4, warning: 1, healthy: 3, issues_open: 1, issues_resolved: 1 });
    expect(report.totals.pass_rate_pct).toBe(50);
    expect(report.by_platform["X"]?.["2026-01-03"]).toEqual({ healthy: 0, warning: 0, failing: 1 });
  });

  it("logs day-over-day changes and recorded actions in the maintenance log", async () => {
    const store = await seeded();
    store.logAction("LI-001", "maintenance", "victor", "re-authorised", "2026-01-03T14:30:00.000Z");
    const log = buildMaintenanceLog(store);
    expect(log).toContain("## Day 2 - 2026-01-02");
    expect(log).toContain("**LI-001** raised `TOKEN_EXPIRED`");
    expect(log).toContain("**LI-001** cleared `TOKEN_EXPIRED`");
    expect(log).toContain("**X-001** account status active -> restricted");
    expect(log).toContain("LI-001 - re-authorised");
    expect(log).toContain("simulated-clock");
  });

  it("renders a dashboard that contains every account and escapes HTML", async () => {
    const store = await seeded();
    store.update("X-001", { owner: "<script>alert(1)</script>" });
    const html = renderDashboard(buildFinalReport(store));
    expect(html).toContain("LI-001");
    expect(html).toContain("X-001");
    expect(html).toContain("ACCOUNT_RESTRICTED");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
