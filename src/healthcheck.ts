import { healthState, isFailing } from "./anomalies.js";
import { TransientPlatformError, type PlatformClient, type PlatformState } from "./platform.js";
import type { Store } from "./store.js";
import type { Account, HealthCheckResult, RunMode } from "./types.js";

export const TOKEN_EXPIRY_WARNING_DAYS = 7;
const DAY_MS = 86_400_000;

export interface RunOptions {
  /** Calendar day the check belongs to (YYYY-MM-DD). Defaults to today (UTC). */
  day?: string;
  /** Clock used for checked_at. Defaults to the real clock. */
  now?: () => Date;
  runMode?: RunMode;
  /** Total attempts per account, including the first. */
  maxAttempts?: number;
  /** Base delay for exponential backoff between attempts. */
  baseDelayMs?: number;
  /** Injectable sleep so tests and simulated runs do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Limit the run to specific accounts. */
  accountIds?: string[];
}

export interface RunSummary {
  day: string;
  run_mode: RunMode;
  total: number;
  healthy: number;
  warning: number;
  failing: number;
  results: HealthCheckResult[];
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Compare what the platform reported with the inventory baseline. */
export function evaluate(
  account: Account,
  state: PlatformState,
  day: string
): { anomalies: string[]; notes: string[] } {
  const anomalies: string[] = [];
  const notes: string[] = [];

  if (state.account_status === "suspended") anomalies.push("ACCOUNT_SUSPENDED");
  if (state.account_status === "restricted") anomalies.push("ACCOUNT_RESTRICTED");
  if (!state.connected) anomalies.push("DISCONNECTED");

  if (state.token_valid === false && state.connected) anomalies.push("TOKEN_EXPIRED");
  if (state.token_valid === true && state.token_expires_at) {
    const daysLeft = (Date.parse(state.token_expires_at) - Date.parse(`${day}T00:00:00Z`)) / DAY_MS;
    if (daysLeft <= TOKEN_EXPIRY_WARNING_DAYS) {
      anomalies.push("TOKEN_EXPIRING_SOON");
      notes.push(`token expires in ${Math.max(0, Math.ceil(daysLeft))} day(s)`);
    }
  }

  // Permission/asset drift is only meaningful while the connection is live.
  if (state.connected) {
    const missingPerms = account.permissions.filter((p) => !state.permissions.includes(p));
    const extraPerms = state.permissions.filter((p) => !account.permissions.includes(p));
    if (missingPerms.length) {
      anomalies.push("PERMISSION_MISSING");
      notes.push(`missing permission(s): ${missingPerms.join(", ")}`);
    }
    if (extraPerms.length) {
      anomalies.push("PERMISSION_UNEXPECTED");
      notes.push(`unexpected permission(s): ${extraPerms.join(", ")}`);
    }
    const missingAssets = account.connected_assets.filter((a) => !state.connected_assets.includes(a));
    if (missingAssets.length) {
      anomalies.push("ASSET_MISSING");
      notes.push(`missing asset(s): ${missingAssets.join(", ")}`);
    }
  }
  return { anomalies, notes };
}

/** Check one account, retrying transient failures with exponential backoff. */
export async function checkAccount(
  account: Account,
  client: PlatformClient,
  opts: Required<Pick<RunOptions, "day" | "now" | "runMode" | "maxAttempts" | "baseDelayMs" | "sleep">>
): Promise<HealthCheckResult> {
  const started = Date.now();
  let attempt = 0;
  let lastError = "";

  while (attempt < opts.maxAttempts) {
    attempt++;
    try {
      const state = await client.fetchState(account, { day: opts.day, attempt });
      const { anomalies, notes } = evaluate(account, state, opts.day);
      if (attempt > 1) {
        anomalies.push("RETRY_RECOVERED");
        notes.push(`succeeded on attempt ${attempt} after: ${lastError}`);
      }
      const failing = anomalies.some(isFailing);
      const connection_status = !state.connected
        ? "disconnected"
        : state.token_valid === false
          ? "error"
          : "connected";
      const platformNote = state.platform_message !== "200 OK" ? [state.platform_message] : [];
      return {
        account_id: account.account_id,
        checked_at: opts.now().toISOString(),
        check_day: opts.day,
        account_status: state.account_status,
        connection_status,
        token_valid: state.token_valid,
        token_expires_at: state.token_expires_at,
        connected_assets: state.connected_assets,
        permissions: state.permissions,
        healthy: !failing,
        anomalies,
        message: [...platformNote, ...notes].join(" | ") || "OK",
        attempts: attempt,
        latency_ms: Date.now() - started,
        run_mode: opts.runMode,
      };
    } catch (err) {
      if (!(err instanceof TransientPlatformError)) throw err;
      lastError = `HTTP ${err.httpStatus} ${err.message}`;
      if (attempt < opts.maxAttempts) {
        await opts.sleep(opts.baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  // Retry budget exhausted: record what we know and flag the check itself.
  return {
    account_id: account.account_id,
    checked_at: opts.now().toISOString(),
    check_day: opts.day,
    account_status: account.status,
    connection_status: "error",
    token_valid: null,
    token_expires_at: null,
    connected_assets: [],
    permissions: [],
    healthy: false,
    anomalies: ["CHECK_FAILED"],
    message: `check failed after ${attempt} attempt(s): ${lastError}`,
    attempts: attempt,
    latency_ms: Date.now() - started,
    run_mode: opts.runMode,
  };
}

/** Run the daily health check across the inventory and persist every result. */
export async function runHealthCheck(
  store: Store,
  client: PlatformClient,
  options: RunOptions = {}
): Promise<RunSummary> {
  const now = options.now ?? (() => new Date());
  const opts = {
    day: options.day ?? todayUtc(now()),
    now,
    runMode: options.runMode ?? ("live" as RunMode),
    maxAttempts: options.maxAttempts ?? 3,
    baseDelayMs: options.baseDelayMs ?? 500,
    sleep: options.sleep ?? realSleep,
  };

  const accounts = store
    .list()
    .filter((a) => a.status !== "retired")
    .filter((a) => !options.accountIds || options.accountIds.includes(a.account_id));

  const results: HealthCheckResult[] = [];
  for (const account of accounts) {
    const result = await checkAccount(account, client, opts);
    store.saveHealthCheck(result);
    results.push(result);
  }

  const states = results.map((r) => healthState(r.anomalies));
  return {
    day: opts.day,
    run_mode: opts.runMode,
    total: results.length,
    healthy: states.filter((s) => s === "healthy").length,
    warning: states.filter((s) => s === "warning").length,
    failing: states.filter((s) => s === "failing").length,
    results,
  };
}
