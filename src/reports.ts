import { healthState, type HealthState } from "./anomalies.js";
import { buildAlerts, type DayAlert } from "./alerts.js";
import { csvEscape } from "./importer.js";
import { deriveIssues, type Issue } from "./issues.js";
import type { Store } from "./store.js";
import { PLATFORMS, type Account, type AuditEntry, type HealthCheckResult } from "./types.js";

// ---------------------------------------------------------------------------
// Daily report
// ---------------------------------------------------------------------------

const DAILY_COLUMNS = [
  "check_day",
  "checked_at",
  "account_id",
  "platform",
  "health",
  "account_status",
  "connection_status",
  "token_valid",
  "token_expires_at",
  "connected_assets",
  "permissions",
  "anomalies",
  "message",
  "attempts",
  "run_mode",
] as const;

export interface DailyReport {
  day: string;
  generated_at: string;
  totals: { accounts: number; healthy: number; warning: number; failing: number };
  alerts: DayAlert[];
  results: Array<HealthCheckResult & { platform: string; health: HealthState }>;
}

export function buildDailyReport(store: Store, day: string, now: Date = new Date()): DailyReport {
  const accounts = store.list();
  const platformOf = new Map(accounts.map((a) => [a.account_id, a.platform]));
  const days = store.checkDays();
  const prevDay = days.filter((d) => d < day).pop();
  const today = store.healthChecks({ day });
  const previous = prevDay ? store.healthChecks({ day: prevDay }) : [];
  const results = today.map((r) => ({
    ...r,
    platform: platformOf.get(r.account_id) ?? "unknown",
    health: healthState(r.anomalies),
  }));
  return {
    day,
    generated_at: now.toISOString(),
    totals: {
      accounts: results.length,
      healthy: results.filter((r) => r.health === "healthy").length,
      warning: results.filter((r) => r.health === "warning").length,
      failing: results.filter((r) => r.health === "failing").length,
    },
    alerts: buildAlerts(today, accounts, previous),
    results,
  };
}

export function dailyReportToCsv(report: DailyReport): string {
  const lines = [DAILY_COLUMNS.join(",")];
  for (const r of report.results) {
    const rec = r as unknown as Record<string, unknown>;
    lines.push(
      DAILY_COLUMNS.map((c) => {
        const v = rec[c];
        return csvEscape(Array.isArray(v) ? v.join(";") : v);
      }).join(",")
    );
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Final (multi-day) report
// ---------------------------------------------------------------------------

export interface FinalReport {
  generated_at: string;
  days: string[];
  accounts: Account[];
  totals: {
    accounts: number;
    days: number;
    checks: number;
    healthy: number;
    warning: number;
    failing: number;
    pass_rate_pct: number;
    issues_open: number;
    issues_resolved: number;
  };
  /** platform -> day -> counts */
  by_platform: Record<string, Record<string, { healthy: number; warning: number; failing: number }>>;
  /** account_id -> day -> result */
  matrix: Record<string, Record<string, HealthCheckResult & { health: HealthState }>>;
  issues: Issue[];
  latest_alerts: DayAlert[];
  audit: AuditEntry[];
}

export function buildFinalReport(store: Store, now: Date = new Date()): FinalReport {
  const accounts = store.list();
  const history = store.healthChecks();
  const days = store.checkDays();
  const audit = store.auditTrail();
  const platformOf = new Map(accounts.map((a) => [a.account_id, a.platform]));

  const matrix: FinalReport["matrix"] = {};
  const by_platform: FinalReport["by_platform"] = {};
  const counts = { healthy: 0, warning: 0, failing: 0 };
  for (const r of history) {
    const health = healthState(r.anomalies);
    counts[health]++;
    (matrix[r.account_id] ??= {})[r.check_day] = { ...r, health };
    const platform = platformOf.get(r.account_id) ?? "unknown";
    const cell = ((by_platform[platform] ??= {})[r.check_day] ??= { healthy: 0, warning: 0, failing: 0 });
    cell[health]++;
  }

  const issues = deriveIssues(history, accounts, audit);
  const lastDay = days[days.length - 1];
  const latest = lastDay ? buildDailyReport(store, lastDay, now).alerts : [];

  return {
    generated_at: now.toISOString(),
    days,
    accounts,
    totals: {
      accounts: accounts.length,
      days: days.length,
      checks: history.length,
      ...counts,
      pass_rate_pct: history.length
        ? Math.round(((counts.healthy + counts.warning) / history.length) * 1000) / 10
        : 0,
      issues_open: issues.filter((i) => i.status === "open").length,
      issues_resolved: issues.filter((i) => i.status === "resolved").length,
    },
    by_platform,
    matrix,
    issues,
    latest_alerts: latest,
    audit,
  };
}

// ---------------------------------------------------------------------------
// Maintenance log (markdown)
// ---------------------------------------------------------------------------

export function buildMaintenanceLog(store: Store): string {
  const accounts = store.list();
  const days = store.checkDays();
  const audit = store.auditTrail();
  const lines: string[] = [];
  lines.push(`# Maintenance log`);
  lines.push("");
  lines.push(
    `Generated from the health-check history and audit trail by \`qa-accounts report all\`. ` +
      `One section per monitored calendar day. Do not edit by hand - record actions with ` +
      `\`qa-accounts maintenance add\` and regenerate.`
  );
  lines.push("");
  const simulatedDays = days.filter((d) => store.healthChecks({ day: d }).some((r) => r.run_mode === "simulated-clock"));
  if (simulatedDays.length) {
    lines.push(
      `> **Data source.** All accounts are mock accounts served by the mock platform layer. ` +
        `${simulatedDays.length} of ${days.length} day(s) below (${simulatedDays.join(", ")}) are simulated-clock runs: ` +
        `the real health-check engine executed with an injected date, and the actions logged on those days are the ` +
        `scripted responses from \`data/maintenance-actions.json\`. Days marked "live run" were executed on that calendar day.`
    );
    lines.push("");
  }

  // The first "connect" entry per account is onboarding; later ones are reconnections.
  const onboarding = new Map<string, AuditEntry>();
  for (const e of audit) {
    if (e.action === "connect" && !onboarding.has(e.account_id)) onboarding.set(e.account_id, e);
  }
  const onboardingIds = new Set([...onboarding.values()].map((e) => e.id));

  lines.push(`## Day 0 - setup and onboarding`);
  lines.push("");
  lines.push(`- ${accounts.length} account record(s) in the inventory:`);
  for (const p of PLATFORMS) {
    lines.push(`  - ${p}: ${accounts.filter((a) => a.platform === p).length}`);
  }
  lines.push(
    `- ${onboarding.size} of ${accounts.length} account(s) taken through the connection workflow (docs/connection-workflow.md):`
  );
  const byDetail = new Map<string, AuditEntry[]>();
  for (const e of onboarding.values()) {
    const key = `${e.at.slice(0, 10)} - ${e.detail} _(by ${e.actor})_`;
    byDetail.set(key, [...(byDetail.get(key) ?? []), e]);
  }
  for (const [key, entries] of byDetail) {
    lines.push(`  - ${entries.map((e) => e.account_id).join(", ")}: ${key}`);
  }
  lines.push("");

  let previous: HealthCheckResult[] = [];
  days.forEach((day, idx) => {
    const today = store.healthChecks({ day });
    const mode = today[0]?.run_mode ?? "live";
    const states = today.map((r) => healthState(r.anomalies));
    lines.push(`## Day ${idx + 1} - ${day}`);
    lines.push("");
    lines.push(
      `- Check type: ${mode === "live" ? "live run" : "simulated-clock run"} · ` +
        `${today.length} accounts checked · ` +
        `${states.filter((s) => s === "healthy").length} healthy, ` +
        `${states.filter((s) => s === "warning").length} warning, ` +
        `${states.filter((s) => s === "failing").length} failing.`
    );

    const prevMap = new Map(previous.map((r) => [r.account_id, r]));
    const changes: string[] = [];
    for (const r of today) {
      const before = prevMap.get(r.account_id);
      const beforeCodes = new Set(before?.anomalies ?? []);
      const nowCodes = new Set(r.anomalies);
      for (const c of nowCodes) if (!beforeCodes.has(c)) changes.push(`**${r.account_id}** raised \`${c}\` - ${r.message}`);
      for (const c of beforeCodes) if (!nowCodes.has(c)) changes.push(`**${r.account_id}** cleared \`${c}\``);
      if (before && before.connection_status !== r.connection_status) {
        changes.push(`**${r.account_id}** connection ${before.connection_status} -> ${r.connection_status}`);
      }
      if (before && before.account_status !== r.account_status) {
        changes.push(`**${r.account_id}** account status ${before.account_status} -> ${r.account_status}`);
      }
    }
    lines.push(`- Changes since previous check:${changes.length ? "" : " none."}`);
    for (const c of changes) lines.push(`  - ${c}`);

    const actions = audit.filter(
      (e) =>
        (e.action === "maintenance" || (e.action === "connect" && !onboardingIds.has(e.id))) &&
        e.at.slice(0, 10) === day
    );
    lines.push(`- Corrective / maintenance actions:${actions.length ? "" : " none required."}`);
    for (const a of actions) lines.push(`  - ${a.account_id} - ${a.detail} _(by ${a.actor})_`);
    lines.push("");
    previous = today;
  });
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// HTML dashboard
// ---------------------------------------------------------------------------

function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const SYMBOL: Record<HealthState, string> = { healthy: "✓", warning: "!", failing: "✕" };
const LABEL: Record<HealthState, string> = { healthy: "Healthy", warning: "Warning", failing: "Failing" };

export function renderDashboard(report: FinalReport): string {
  const t = report.totals;
  const modeOf = (d: string): string => {
    const modes = new Set(Object.values(report.matrix).map((m) => m[d]?.run_mode).filter(Boolean));
    return modes.size === 1 && modes.has("live") ? "live run" : "simulated clock";
  };
  const dayHeads = report.days
    .map(
      (d, i) =>
        `<th scope="col"><span class="daynum">Day ${i + 1}</span><span class="date">${esc(d)}</span><span class="mode">${modeOf(d)}</span></th>`
    )
    .join("");

  const matrixRows: string[] = [];
  for (const platform of PLATFORMS) {
    const accounts = report.accounts.filter((a) => a.platform === platform);
    if (!accounts.length) continue;
    matrixRows.push(`<tr class="group"><th colspan="${report.days.length + 2}" scope="colgroup">${esc(platform)}</th></tr>`);
    for (const a of accounts) {
      const cells = report.days
        .map((d) => {
          const r = report.matrix[a.account_id]?.[d];
          if (!r) return `<td class="cell none" title="No check recorded">–</td>`;
          const tip = `${LABEL[r.health]} · ${r.connection_status} · ${r.anomalies.join(", ") || "no anomalies"} · ${r.message}`;
          const codes = r.anomalies.length ? `<span class="codes">${esc(r.anomalies.join(", "))}</span>` : "";
          return `<td class="cell ${r.health}" title="${esc(tip)}"><span class="sym" aria-hidden="true">${SYMBOL[r.health]}</span><span class="sr">${LABEL[r.health]}</span>${codes}</td>`;
        })
        .join("");
      matrixRows.push(
        `<tr><th scope="row"><span class="acct">${esc(a.account_id)}</span></th><td class="type">${esc(a.account_type)}</td>${cells}</tr>`
      );
    }
  }

  const platformRows = PLATFORMS.filter((p) => report.by_platform[p])
    .map((p) => {
      const cells = report.days
        .map((d) => {
          const c = report.by_platform[p]?.[d] ?? { healthy: 0, warning: 0, failing: 0 };
          const total = c.healthy + c.warning + c.failing;
          const cls = c.failing ? "failing" : c.warning ? "warning" : "healthy";
          return `<td class="num ${cls}">${c.healthy + c.warning}/${total}</td>`;
        })
        .join("");
      return `<tr><th scope="row">${esc(p)}</th>${cells}</tr>`;
    })
    .join("");

  const issueRows = report.issues
    .map(
      (i) => `<tr>
        <td class="nw"><a href="../docs/issues/${esc(i.id)}.md">${esc(i.id)}</a></td>
        <td class="nw">${esc(i.account_id)}</td><td>${esc(i.platform)}</td>
        <td><code>${esc(i.code)}</code></td>
        <td><span class="pill sev-${esc(i.severity)}">${esc(i.severity)}</span></td>
        <td class="nw">${esc(i.first_seen)}</td>
        <td class="nw">${i.status === "open" ? `<span class="pill open">open</span>` : `resolved ${esc(i.resolved_on)}`}</td>
        <td>${esc(i.recommended_action)}</td></tr>`
    )
    .join("");

  const alertRows = report.latest_alerts
    .map(
      (a) => `<tr><td><span class="pill sev-${esc(a.severity)}">${esc(a.severity)}</span></td>
        <td>${esc(a.account_id)}</td><td><code>${esc(a.code)}</code>${a.is_new ? ` <span class="pill new">new</span>` : ""}</td>
        <td>${esc(a.message)}</td></tr>`
    )
    .join("");

  const inventoryRows = report.accounts
    .map(
      (a) => `<tr><td>${esc(a.account_id)}</td><td>${esc(a.platform)}</td><td>${esc(a.account_type)}</td>
        <td>${esc(a.environment)}</td><td>${esc(a.owner)}</td><td>${esc(a.status)}</td><td>${esc(a.connection_status)}</td>
        <td>${esc(a.connected_assets.join("; "))}</td><td>${esc(a.permissions.join("; "))}</td>
        <td><code>${esc(a.credential_ref_id)}</code></td></tr>`
    )
    .join("");

  const modes = new Set(Object.values(report.matrix).flatMap((m) => Object.values(m).map((r) => r.run_mode)));
  const modeNote =
    modes.size === 0
      ? ""
      : modes.has("simulated-clock") && modes.has("live")
        ? "Mix of live runs and simulated-clock runs against the mock platform layer."
        : modes.has("simulated-clock")
          ? "All runs are simulated-clock runs against the mock platform layer."
          : "All runs are live runs against the mock platform layer.";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QA test-account health dashboard</title>
<style>
  :root {
    --bg: #f6f7f9; --panel: #ffffff; --ink: #16202b; --muted: #5d6b7a; --line: #dfe4ea;
    --ok: #0b7a4b; --ok-bg: #e3f4ec; --warn: #8a5a00; --warn-bg: #fdf1d3; --bad: #b3261e; --bad-bg: #fbe4e2;
    --accent: #2456c9;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #10151b; --panel: #18202a; --ink: #e7ecf2; --muted: #9aa7b5; --line: #2a3542;
      --ok: #5fd19d; --ok-bg: #12382a; --warn: #f0c45c; --warn-bg: #3d3010; --bad: #ff8f86; --bad-bg: #45191a;
      --accent: #8fb0ff;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 1120px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -0.01em; }
  h2 { font-size: 17px; margin: 0 0 12px; }
  p.sub { margin: 0 0 24px; color: var(--muted); }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 20px; margin-bottom: 20px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .tile { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
  .tile .k { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
  .tile .v { font-size: 26px; font-weight: 650; font-variant-numeric: tabular-nums; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { padding: 8px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
  thead th { font-size: 12px; color: var(--muted); font-weight: 600; white-space: nowrap; }
  .daynum { display: block; color: var(--ink); font-size: 13px; }
  .date, .mode { display: block; font-weight: 400; }
  .mode { font-size: 11px; }
  .nw { white-space: nowrap; }
  tr.group th { background: var(--bg); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
  .acct { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; }
  .type { color: var(--muted); }
  .cell { min-width: 120px; }
  .cell .sym { display: inline-block; width: 22px; height: 22px; line-height: 22px; text-align: center; border-radius: 50%; font-weight: 700; margin-right: 6px; }
  .cell .codes { font-size: 11.5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .healthy .sym { background: var(--ok-bg); color: var(--ok); }
  .warning .sym { background: var(--warn-bg); color: var(--warn); }
  .failing .sym { background: var(--bad-bg); color: var(--bad); }
  .warning .codes { color: var(--warn); } .failing .codes { color: var(--bad); }
  td.num { font-variant-numeric: tabular-nums; font-weight: 600; }
  td.num.healthy { color: var(--ok); } td.num.warning { color: var(--warn); } td.num.failing { color: var(--bad); }
  .none { color: var(--muted); }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; border: 1px solid var(--line); }
  .sev-critical, .sev-high, .open { background: var(--bad-bg); color: var(--bad); border-color: transparent; }
  .sev-medium { background: var(--warn-bg); color: var(--warn); border-color: transparent; }
  .sev-low, .new { background: var(--bg); color: var(--muted); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
  a { color: var(--accent); }
  .legend { color: var(--muted); font-size: 13px; margin: 12px 0 0; }
  .empty { color: var(--muted); margin: 0; }
  footer { color: var(--muted); font-size: 12.5px; }
</style>
</head>
<body>
<main>
  <h1>QA test-account health dashboard</h1>
  <p class="sub">${t.accounts} accounts across ${Object.keys(report.by_platform).length} platforms, ${t.days} monitored day(s). ${esc(modeNote)}</p>

  <div class="tiles">
    <div class="tile"><div class="k">Accounts</div><div class="v">${t.accounts}</div></div>
    <div class="tile"><div class="k">Days monitored</div><div class="v">${t.days}</div></div>
    <div class="tile"><div class="k">Checks run</div><div class="v">${t.checks}</div></div>
    <div class="tile"><div class="k">Pass rate</div><div class="v">${t.pass_rate_pct}%</div></div>
    <div class="tile"><div class="k">Failing checks</div><div class="v">${t.failing}</div></div>
    <div class="tile"><div class="k">Issues open / resolved</div><div class="v">${t.issues_open} / ${t.issues_resolved}</div></div>
  </div>

  <section>
    <h2>Account health by day</h2>
    <div class="scroll"><table>
      <thead><tr><th scope="col">Account</th><th scope="col">Type</th>${dayHeads}</tr></thead>
      <tbody>${matrixRows.join("\n")}</tbody>
    </table></div>
    <p class="legend">✓ healthy · ! warning (no action required yet) · ✕ failing. Hover a cell for the recorded detail.</p>
  </section>

  <section>
    <h2>Passing accounts per platform</h2>
    <div class="scroll"><table>
      <thead><tr><th scope="col">Platform</th>${dayHeads}</tr></thead>
      <tbody>${platformRows}</tbody>
    </table></div>
  </section>

  <section>
    <h2>Issues</h2>
    ${
      issueRows
        ? `<div class="scroll"><table><thead><tr><th>ID</th><th>Account</th><th>Platform</th><th>Code</th><th>Severity</th><th>First seen</th><th>Status</th><th>Recommended next action</th></tr></thead><tbody>${issueRows}</tbody></table></div>`
        : `<p class="empty">No issues detected.</p>`
    }
  </section>

  <section>
    <h2>Alerts on the latest day${report.days.length ? ` (${esc(report.days[report.days.length - 1])})` : ""}</h2>
    ${
      alertRows
        ? `<div class="scroll"><table><thead><tr><th>Severity</th><th>Account</th><th>Code</th><th>Detail</th></tr></thead><tbody>${alertRows}</tbody></table></div>`
        : `<p class="empty">No alerts.</p>`
    }
  </section>

  <section>
    <h2>Account inventory</h2>
    <div class="scroll"><table>
      <thead><tr><th>ID</th><th>Platform</th><th>Type</th><th>Env</th><th>Owner</th><th>Status</th><th>Connection</th><th>Expected assets</th><th>Expected permissions</th><th>Credential ref</th></tr></thead>
      <tbody>${inventoryRows}</tbody>
    </table></div>
  </section>

  <footer>Generated ${esc(report.generated_at)} by qa-accounts. No credentials are stored in or rendered by this report - only credential reference IDs.</footer>
</main>
</body>
</html>
`;
}
