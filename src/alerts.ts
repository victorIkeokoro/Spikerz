import { anomalyInfo } from "./anomalies.js";
import type { Account, Alert, HealthCheckResult } from "./types.js";

export interface DayAlert extends Alert {
  /** true when this anomaly was not present on the previous checked day. */
  is_new: boolean;
}

/** Turn one day's results into alerts, marking which ones are new since the previous day. */
export function buildAlerts(
  today: HealthCheckResult[],
  accounts: Account[],
  previous: HealthCheckResult[] = []
): DayAlert[] {
  const platformOf = new Map(accounts.map((a) => [a.account_id, a.platform]));
  const prev = new Map(previous.map((r) => [r.account_id, new Set(r.anomalies)]));
  const alerts: DayAlert[] = [];
  for (const r of today) {
    for (const code of r.anomalies) {
      const info = anomalyInfo(code);
      alerts.push({
        account_id: r.account_id,
        platform: platformOf.get(r.account_id) ?? "X",
        code,
        severity: info.severity,
        message: `${info.title} - ${r.message}`,
        at: r.checked_at,
        recommended_action: info.recommended_action,
        is_new: !(prev.get(r.account_id)?.has(code) ?? false),
      });
    }
  }
  const rank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  return alerts.sort((a, b) => rank[a.severity] - rank[b.severity] || a.account_id.localeCompare(b.account_id));
}

export function formatAlert(a: DayAlert): string {
  return `[${a.severity.toUpperCase()}]${a.is_new ? " NEW" : ""} ${a.account_id} (${a.platform}) ${a.code}: ${a.message}`;
}

/**
 * Optionally push alerts to a webhook (Slack-compatible payload).
 * Only failing-severity, newly raised alerts are sent, to keep the channel quiet.
 */
export async function sendAlerts(
  alerts: DayAlert[],
  webhookUrl: string | undefined,
  post: (url: string, body: string) => Promise<void> = defaultPost
): Promise<number> {
  const toSend = alerts.filter((a) => a.is_new && a.severity !== "low");
  if (!webhookUrl || toSend.length === 0) return 0;
  await post(webhookUrl, JSON.stringify({ text: toSend.map(formatAlert).join("\n") }));
  return toSend.length;
}

async function defaultPost(url: string, body: string): Promise<void> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
  if (!res.ok) throw new Error(`alert webhook responded ${res.status}`);
}

/**
 * Like sendAlerts, but a webhook failure is returned instead of thrown.
 * Alerting is best-effort: it must never fail a health check whose results
 * are already saved.
 */
export async function notify(
  alerts: DayAlert[],
  webhookUrl: string | undefined,
  post?: (url: string, body: string) => Promise<void>
): Promise<{ sent: number; error?: string }> {
  try {
    return { sent: await sendAlerts(alerts, webhookUrl, post) };
  } catch (err) {
    return { sent: 0, error: (err as Error).message };
  }
}
