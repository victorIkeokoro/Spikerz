import { anomalyInfo, isFailing } from "./anomalies.js";
import type { Account, AuditEntry, HealthCheckResult, Platform, Severity } from "./types.js";

export interface Issue {
  id: string;
  account_id: string;
  platform: Platform;
  code: string;
  title: string;
  severity: Severity;
  first_seen: string;
  last_seen: string;
  /** Day the anomaly was first observed cleared, or null while still open. */
  resolved_on: string | null;
  status: "open" | "resolved";
  days_affected: number;
  evidence: HealthCheckResult[];
  likely_cause: string;
  recommended_action: string;
  corrective_actions: AuditEntry[];
}

const CONNECTION_DEPENDENT_ANOMALIES = new Set([
  "TOKEN_EXPIRED",
  "TOKEN_EXPIRING_SOON",
  "PERMISSION_MISSING",
  "PERMISSION_UNEXPECTED",
  "ASSET_MISSING",
]);

/** Whether this check can prove that a previously observed anomaly has cleared. */
export function canResolve(
  code: string,
  row: Pick<HealthCheckResult, "anomalies" | "connection_status">
): boolean {
  if (row.anomalies.includes("CHECK_FAILED")) return false;
  if (
    CONNECTION_DEPENDENT_ANOMALIES.has(code) &&
    (row.connection_status === "disconnected" || row.anomalies.includes("DISCONNECTED"))
  ) {
    return false;
  }
  return true;
}

/**
 * Derive issues from the health-check history: every contiguous run of days on
 * which an account shows the same failing anomaly becomes one issue. An issue
 * stays open when a later check cannot observe whether that anomaly cleared.
 */
export function deriveIssues(
  history: HealthCheckResult[],
  accounts: Account[],
  audit: AuditEntry[] = []
): Issue[] {
  const platformOf = new Map(accounts.map((a) => [a.account_id, a.platform]));
  const byAccount = new Map<string, HealthCheckResult[]>();
  for (const r of history) {
    const list = byAccount.get(r.account_id) ?? [];
    list.push(r);
    byAccount.set(r.account_id, list);
  }

  const issues: Omit<Issue, "id">[] = [];
  for (const [accountId, rows] of byAccount) {
    rows.sort((a, b) => a.check_day.localeCompare(b.check_day));
    const open = new Map<string, Omit<Issue, "id">>();
    for (const row of rows) {
      const failing = row.anomalies.filter(isFailing);
      for (const code of failing) {
        const current = open.get(code);
        if (current) {
          current.last_seen = row.check_day;
          current.days_affected++;
          current.evidence.push(row);
        } else {
          const info = anomalyInfo(code);
          open.set(code, {
            account_id: accountId,
            platform: platformOf.get(accountId) ?? "X",
            code,
            title: info.title,
            severity: info.severity,
            first_seen: row.check_day,
            last_seen: row.check_day,
            resolved_on: null,
            status: "open",
            days_affected: 1,
            evidence: [row],
            likely_cause: info.likely_cause,
            recommended_action: info.recommended_action,
            corrective_actions: [],
          });
        }
      }
      for (const [code, issue] of [...open]) {
        if (!failing.includes(code) && canResolve(code, row)) {
          issue.resolved_on = row.check_day;
          issue.status = "resolved";
          issues.push(issue);
          open.delete(code);
        }
      }
    }
    issues.push(...open.values());
  }

  for (const issue of issues) {
    const until = issue.resolved_on ?? "9999-12-31";
    issue.corrective_actions = audit.filter(
      (e) =>
        e.account_id === issue.account_id &&
        (e.action === "maintenance" || e.action === "connect") &&
        e.at.slice(0, 10) >= issue.first_seen &&
        e.at.slice(0, 10) <= until
    );
  }

  issues.sort((a, b) => a.first_seen.localeCompare(b.first_seen) || a.account_id.localeCompare(b.account_id));
  return issues.map((issue, i) => ({ id: `ISS-${String(i + 1).padStart(3, "0")}`, ...issue }));
}

export function issueToMarkdown(issue: Issue): string {
  const first = issue.evidence[0]!;
  const lines: string[] = [];
  lines.push(`# ${issue.id}: ${issue.title} - ${issue.account_id} (${issue.platform})`);
  lines.push("");
  lines.push(`| Field | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Status | ${issue.status === "open" ? "Open" : `Resolved (cleared on ${issue.resolved_on})`} |`);
  lines.push(`| Severity | ${issue.severity} |`);
  lines.push(`| Account | ${issue.account_id} (${issue.platform}) |`);
  lines.push(`| Anomaly code | \`${issue.code}\` |`);
  lines.push(`| First seen | ${issue.first_seen} |`);
  lines.push(`| Last seen | ${issue.last_seen} |`);
  lines.push(`| Days affected | ${issue.days_affected} |`);
    lines.push(
    `| Data source | ${first.run_mode === "live" ? "live-clock check" : "simulated-clock check"} against the mock platform layer. No real social platform or Spikerz workspace was involved. |`
  );
  lines.push("");
  lines.push(`## Summary`);
  lines.push("");
  lines.push(`The daily health check for **${issue.account_id}** reported \`${issue.code}\` on ${issue.first_seen}. Detail recorded by the check: _${first.message}_`);
  lines.push("");
  lines.push(`## Reproduction steps`);
  lines.push("");
  lines.push(`1. Import the inventory: \`npm run cli -- account import --file data/accounts.seed.csv\``);
  lines.push(`2. Run the check for the affected day: \`npm run cli -- check run --date ${issue.first_seen} --account ${issue.account_id}\``);
  lines.push(`3. Inspect the stored result: \`npm run cli -- check history --account ${issue.account_id}\``);
  lines.push("");
  lines.push(`**Expected:** account active, connected, token valid, all baseline permissions and assets present.`);
  lines.push("");
  lines.push(`**Actual:** account_status=\`${first.account_status}\`, connection_status=\`${first.connection_status}\`, token_valid=\`${first.token_valid}\`, anomalies=\`${first.anomalies.join(", ")}\`.`);
  lines.push("");
  lines.push(`## Evidence`);
  lines.push("");
  lines.push(`| Day | Checked at (UTC) | Account status | Connection | Token valid | Anomalies | Message |`);
  lines.push(`|---|---|---|---|---|---|---|`);
  for (const e of issue.evidence) {
    lines.push(
      `| ${e.check_day} | ${e.checked_at} | ${e.account_status} | ${e.connection_status} | ${e.token_valid} | ${e.anomalies.join(", ")} | ${e.message.replace(/\|/g, "/")} |`
    );
  }
  lines.push("");
  lines.push(`Raw records: \`reports/daily/health-${issue.first_seen}.json\` (filter on \`account_id = "${issue.account_id}"\`).`);
  lines.push("");
  lines.push(`## Likely root cause`);
  lines.push("");
  lines.push(issue.likely_cause);
  lines.push("");
  lines.push(`## Recommended next action`);
  lines.push("");
  lines.push(issue.recommended_action);
  lines.push("");
  lines.push(`## Corrective actions`);
  lines.push("");
  lines.push(`Entries starting "Simulated:" describe the runbook response for this anomaly. They were not carried out.`);
  lines.push("");
  if (issue.corrective_actions.length === 0) {
    lines.push(`_None recorded yet._`);
  } else {
    for (const a of issue.corrective_actions) {
      lines.push(`- ${a.at.slice(0, 10)} - ${a.actor}: ${a.detail}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
