/**
 * Shared domain types for the Spikerz QA account-management tool.
 */

export const PLATFORMS = ["LinkedIn", "Facebook", "Instagram", "TikTok", "X"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const ACCOUNT_TYPES = ["profile", "page", "business", "creator"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Lifecycle status of the account itself. */
export const ACCOUNT_STATUSES = ["active", "restricted", "suspended", "retired"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/** Whether the account is currently connected to the Spikerz UI. */
export const CONNECTION_STATUSES = ["connected", "disconnected", "pending", "error"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export interface Account {
  account_id: string;
  platform: Platform;
  account_type: AccountType;
  environment: string;
  owner: string;
  status: AccountStatus;
  connection_status: ConnectionStatus;
  /** Comma-free list of connected asset identifiers (pages, ad accounts, etc.). */
  connected_assets: string[];
  /** Granted permission scopes. */
  permissions: string[];
  /** ISO timestamp of the most recent health check, or null if never checked. */
  last_health_check: string | null;
  notes: string;
  /**
   * Reference ID for the credential (e.g. "CRED-LI-001").
   * The secret itself is NEVER stored here — only this pointer.
   */
  credential_ref_id: string;
}

/** The result of a single health check against a single account. */
export interface HealthCheckResult {
  id?: number;
  account_id: string;
  checked_at: string; // ISO timestamp
  check_day: string; // YYYY-MM-DD — which calendar day this check belongs to
  account_status: AccountStatus;
  connection_status: ConnectionStatus;
  /** null when the platform/account does not use tokens. */
  token_valid: boolean | null;
  /** null when not applicable. */
  token_expires_at: string | null;
  connected_assets: string[];
  permissions: string[];
  /** true when there are no failing anomalies (warnings alone do not make an account unhealthy). */
  healthy: boolean;
  /** Machine-readable anomaly codes, e.g. ["TOKEN_EXPIRED"]. Empty when healthy. */
  anomalies: string[];
  /** Human-readable detail of errors/warnings. */
  message: string;
  /** How many attempts the check took (retry logic). */
  attempts: number;
  latency_ms: number;
  /**
   * "live" = executed at the real wall-clock time recorded in checked_at.
   * "simulated-clock" = executed with an injected date (used to exercise the
   * multi-day scenarios inside a shorter real-world window).
   */
  run_mode: RunMode;
}

export const RUN_MODES = ["live", "simulated-clock"] as const;
export type RunMode = (typeof RUN_MODES)[number];

export type AuditAction = "create" | "update" | "delete" | "import" | "retire" | "health_check" | "maintenance" | "connect";

export interface AuditEntry {
  id?: number;
  account_id: string;
  action: AuditAction;
  actor: string;
  at: string; // ISO timestamp
  detail: string;
}

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Alert {
  account_id: string;
  platform: Platform;
  code: string;
  severity: Severity;
  message: string;
  at: string;
  recommended_action: string;
}
