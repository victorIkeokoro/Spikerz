import type { Severity } from "./types.js";

export interface AnomalyInfo {
  title: string;
  severity: Severity;
  /** false = warning only; the account still counts as healthy. */
  failing: boolean;
  likely_cause: string;
  recommended_action: string;
}

/** Single source of truth for every anomaly code the engine can raise. */
export const ANOMALY_CATALOG: Record<string, AnomalyInfo> = {
  ACCOUNT_SUSPENDED: {
    title: "Account suspended by platform",
    severity: "critical",
    failing: true,
    likely_cause: "Platform enforcement action against the account (policy or integrity signal).",
    recommended_action:
      "Stop all automated activity on the account, appeal through the platform's official channel, and provision a replacement test account.",
  },
  ACCOUNT_RESTRICTED: {
    title: "Account restricted by platform",
    severity: "high",
    failing: true,
    likely_cause:
      "Platform integrity checks flagged the account (unusual login pattern, new-account activity limits, or automation signals).",
    recommended_action:
      "Pause tests using this account, complete any platform verification prompts manually, and swap in a standby account if the restriction lasts more than 48h.",
  },
  DISCONNECTED: {
    title: "Account disconnected from Spikerz",
    severity: "high",
    failing: true,
    likely_cause:
      "The platform session/grant was invalidated (password change, user revoked the app, or forced logout).",
    recommended_action: "Reconnect the account through the Spikerz UI connection flow and re-run the health check.",
  },
  TOKEN_EXPIRED: {
    title: "Access token expired",
    severity: "high",
    failing: true,
    likely_cause: "Access token reached end of life and was not refreshed (refresh token missing, rotated, or expired).",
    recommended_action: "Re-authorise the account to mint a new token; check why the scheduled refresh did not run.",
  },
  PERMISSION_MISSING: {
    title: "Expected permission no longer granted",
    severity: "medium",
    failing: true,
    likely_cause: "A scope was revoked or the connecting user's role on the asset was downgraded.",
    recommended_action:
      "Restore the role/scope on the platform side, then reconnect in Spikerz so the missing permission is re-granted.",
  },
  ASSET_MISSING: {
    title: "Expected connected asset is missing",
    severity: "medium",
    failing: true,
    likely_cause: "The asset (page / handle) was unlinked, unpublished, or the connected user lost access to it.",
    recommended_action: "Confirm the asset still exists and the connected user still has access, then re-select it in Spikerz.",
  },
  CHECK_FAILED: {
    title: "Health check could not complete",
    severity: "medium",
    failing: true,
    likely_cause: "Platform API unavailable or rate limiting persisted beyond the retry budget.",
    recommended_action: "Re-run the check later; if it persists across two runs, check the platform status page and quota usage.",
  },
  TOKEN_EXPIRING_SOON: {
    title: "Access token expires within 7 days",
    severity: "low",
    failing: false,
    likely_cause: "Token is approaching end of life.",
    recommended_action: "Refresh or re-authorise before expiry to avoid a disconnect.",
  },
  PERMISSION_UNEXPECTED: {
    title: "Permission granted that is not in the inventory baseline",
    severity: "low",
    failing: false,
    likely_cause: "Account was reconnected with a wider scope set than documented.",
    recommended_action: "Either update the inventory baseline or reconnect with the documented scopes (least privilege).",
  },
  RETRY_RECOVERED: {
    title: "Check succeeded only after retry",
    severity: "low",
    failing: false,
    likely_cause: "Temporary platform failure (rate limit / timeout) that cleared within the retry budget.",
    recommended_action: "No action needed. If this recurs daily, lower check concurrency or stagger the schedule.",
  },
};

export function anomalyInfo(code: string): AnomalyInfo {
  return (
    ANOMALY_CATALOG[code] ?? {
      title: code,
      severity: "medium",
      failing: true,
      likely_cause: "Unknown.",
      recommended_action: "Investigate manually.",
    }
  );
}

export function isFailing(code: string): boolean {
  return anomalyInfo(code).failing;
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function worstSeverity(codes: string[]): Severity | null {
  let worst: Severity | null = null;
  for (const c of codes) {
    const s = anomalyInfo(c).severity;
    if (worst === null || SEVERITY_RANK[s] < SEVERITY_RANK[worst]) worst = s;
  }
  return worst;
}

export type HealthState = "healthy" | "warning" | "failing";

export function healthState(anomalies: string[]): HealthState {
  if (anomalies.some(isFailing)) return "failing";
  return anomalies.length > 0 ? "warning" : "healthy";
}
