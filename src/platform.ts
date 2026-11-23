import { readFileSync } from "node:fs";
import type { Account, AccountStatus } from "./types.js";

/** What a platform reports about one account at one point in time. */
export interface PlatformState {
  account_status: AccountStatus;
  /** Whether the Spikerz <-> platform connection is live. */
  connected: boolean;
  /** null when the integration does not use expiring tokens. */
  token_valid: boolean | null;
  token_expires_at: string | null;
  connected_assets: string[];
  permissions: string[];
  /** Raw-ish message from the platform (error text, warning) for evidence. */
  platform_message: string;
}

export interface CheckContext {
  /** Calendar day being checked, YYYY-MM-DD. */
  day: string;
  /** 1-based attempt number (for retry logic). */
  attempt: number;
}

/**
 * Adapter boundary. The health-check engine only talks to this interface, so
 * a real implementation (official platform APIs, or the Spikerz API) can be
 * swapped in per platform without touching the engine, reports or tests.
 */
export interface PlatformClient {
  fetchState(account: Account, ctx: CheckContext): Promise<PlatformState>;
}

/** A failure worth retrying: rate limit, timeout, 5xx. */
export class TransientPlatformError extends Error {
  constructor(
    message: string,
    public readonly httpStatus = 429
  ) {
    super(message);
    this.name = "TransientPlatformError";
  }
}

// ---------------------------------------------------------------------------
// Mock implementation
// ---------------------------------------------------------------------------

export type ScenarioEffect =
  | "rate_limited"
  | "permission_removed"
  | "token_expired"
  | "token_expiring"
  | "restricted"
  | "suspended"
  | "disconnected"
  | "asset_removed"
  | "outage";

export interface ScenarioEvent {
  account_id: string;
  from_day: number;
  to_day: number;
  effect: ScenarioEffect;
  value?: string;
  fail_attempts?: number;
  days_left?: number;
  detail?: string;
}

export interface ScenarioFile {
  monitoring_start: string;
  default_token_lifetime_days?: number;
  events: ScenarioEvent[];
}

export function loadScenarios(path: string): ScenarioFile {
  return JSON.parse(readFileSync(path, "utf8")) as ScenarioFile;
}

const DAY_MS = 86_400_000;

export function dayNumber(day: string, start: string): number {
  return Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1;
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Deterministic stand-in for the five social platforms.
 *
 * A healthy account simply reports its inventory baseline back. Scripted
 * events from the scenario file then degrade specific accounts on specific
 * days. No network calls are made and no real account is touched.
 */
export class MockPlatformClient implements PlatformClient {
  constructor(private readonly scenarios: ScenarioFile) {}

  async fetchState(account: Account, ctx: CheckContext): Promise<PlatformState> {
    const n = dayNumber(ctx.day, this.scenarios.monitoring_start);
    const events = this.scenarios.events.filter(
      (e) => e.account_id === account.account_id && n >= e.from_day && n <= e.to_day
    );
    const lifetime = this.scenarios.default_token_lifetime_days ?? 60;

    const state: PlatformState = {
      account_status: "active",
      connected: true,
      token_valid: true,
      token_expires_at: `${addDays(this.scenarios.monitoring_start, lifetime)}T00:00:00.000Z`,
      connected_assets: [...account.connected_assets],
      permissions: [...account.permissions],
      platform_message: "200 OK",
    };

    for (const e of events) {
      const detail = e.detail ?? e.effect;
      switch (e.effect) {
        case "rate_limited":
          if (ctx.attempt <= (e.fail_attempts ?? 1)) throw new TransientPlatformError(detail, 429);
          break;
        case "outage":
          throw new TransientPlatformError(detail, 503);
        case "permission_removed":
          state.permissions = state.permissions.filter((p) => p !== e.value);
          state.platform_message = detail;
          break;
        case "asset_removed":
          state.connected_assets = state.connected_assets.filter((a) => a !== e.value);
          state.platform_message = detail;
          break;
        case "token_expired":
          state.token_valid = false;
          state.token_expires_at = `${addDays(ctx.day, -1)}T23:59:59.000Z`;
          state.platform_message = detail;
          break;
        case "token_expiring":
          state.token_expires_at = `${addDays(ctx.day, e.days_left ?? 3)}T00:00:00.000Z`;
          state.platform_message = detail;
          break;
        case "restricted":
          state.account_status = "restricted";
          state.platform_message = detail;
          break;
        case "suspended":
          state.account_status = "suspended";
          state.connected = false;
          state.platform_message = detail;
          break;
        case "disconnected":
          state.connected = false;
          state.token_valid = false;
          state.platform_message = detail;
          break;
      }
    }
    return state;
  }
}
