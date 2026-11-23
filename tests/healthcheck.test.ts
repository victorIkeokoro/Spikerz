import { describe, expect, it, vi } from "vitest";
import { healthState } from "../src/anomalies.js";
import { evaluate, runHealthCheck } from "../src/healthcheck.js";
import {
  MockPlatformClient,
  TransientPlatformError,
  dayNumber,
  type PlatformClient,
  type PlatformState,
  type ScenarioEvent,
} from "../src/platform.js";
import { account, memoryStore, noSleep } from "./helpers.js";

const START = "2026-01-01";
const mock = (events: ScenarioEvent[] = []) =>
  new MockPlatformClient({ monitoring_start: START, default_token_lifetime_days: 60, events });

const healthyState = (over: Partial<PlatformState> = {}): PlatformState => ({
  account_status: "active",
  connected: true,
  token_valid: true,
  token_expires_at: "2026-03-01T00:00:00.000Z",
  connected_assets: ["page:A"],
  permissions: ["read", "write"],
  platform_message: "200 OK",
  ...over,
});

describe("evaluate - anomaly detection against the inventory baseline", () => {
  it("returns no anomalies for a healthy account", () => {
    expect(evaluate(account(), healthyState(), START).anomalies).toEqual([]);
  });

  it.each([
    [{ account_status: "restricted" as const }, "ACCOUNT_RESTRICTED"],
    [{ account_status: "suspended" as const }, "ACCOUNT_SUSPENDED"],
    [{ connected: false, token_valid: false }, "DISCONNECTED"],
    [{ token_valid: false }, "TOKEN_EXPIRED"],
    [{ permissions: ["read"] }, "PERMISSION_MISSING"],
    [{ permissions: ["read", "write", "admin"] }, "PERMISSION_UNEXPECTED"],
    [{ connected_assets: [] }, "ASSET_MISSING"],
    [{ token_expires_at: "2026-01-04T00:00:00.000Z" }, "TOKEN_EXPIRING_SOON"],
  ])("flags %j as %s", (over, code) => {
    expect(evaluate(account(), healthyState(over), START).anomalies).toContain(code);
  });

  it("does not report permission drift for a disconnected account (one root cause, one anomaly)", () => {
    const { anomalies } = evaluate(account(), healthyState({ connected: false, token_valid: false, permissions: [] }), START);
    expect(anomalies).toEqual(["DISCONNECTED"]);
  });

  it("names the missing permission in the notes", () => {
    const { notes } = evaluate(account(), healthyState({ permissions: ["read"] }), START);
    expect(notes.join()).toContain("write");
  });

  it("treats warnings as non-failing", () => {
    expect(healthState(["TOKEN_EXPIRING_SOON"])).toBe("warning");
    expect(healthState(["TOKEN_EXPIRING_SOON", "DISCONNECTED"])).toBe("failing");
    expect(healthState([])).toBe("healthy");
  });
});

describe("runHealthCheck", () => {
  it("checks every non-retired account, stores results and updates the account record", async () => {
    const store = memoryStore();
    store.upsert(account());
    store.upsert(account({ account_id: "LI-002" }));
    store.upsert(account({ account_id: "LI-OLD", status: "retired" }));
    const summary = await runHealthCheck(store, mock(), { day: START, sleep: noSleep });
    expect(summary).toMatchObject({ total: 2, healthy: 2, failing: 0 });
    expect(store.healthChecks({ day: START })).toHaveLength(2);
    expect(store.get("LI-001")?.last_health_check).not.toBeNull();
    expect(store.get("LI-OLD")?.last_health_check).toBeNull();
  });

  it("records the required fields for each check", async () => {
    const store = memoryStore();
    store.upsert(account());
    await runHealthCheck(store, mock(), { day: START, sleep: noSleep });
    const [r] = store.healthChecks();
    expect(r).toMatchObject({
      account_id: "LI-001",
      check_day: START,
      account_status: "active",
      connection_status: "connected",
      token_valid: true,
      connected_assets: ["page:A"],
      permissions: ["read", "write"],
      anomalies: [],
      healthy: true,
      run_mode: "live",
    });
    expect(Number.isNaN(Date.parse(r!.checked_at))).toBe(false);
  });

  it("retries a transient failure with exponential backoff and recovers", async () => {
    const store = memoryStore();
    store.upsert(account());
    const sleep = vi.fn(async (_ms: number): Promise<void> => {});
    const client = mock([{ account_id: "LI-001", from_day: 1, to_day: 1, effect: "rate_limited", fail_attempts: 2 }]);
    const summary = await runHealthCheck(store, client, { day: START, sleep, baseDelayMs: 100 });
    const r = summary.results[0]!;
    expect(r.attempts).toBe(3);
    expect(r.healthy).toBe(true);
    expect(r.anomalies).toEqual(["RETRY_RECOVERED"]);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200]);
  });

  it("marks the check as failed when the retry budget is exhausted", async () => {
    const store = memoryStore();
    store.upsert(account());
    const client = mock([{ account_id: "LI-001", from_day: 1, to_day: 1, effect: "outage" }]);
    const summary = await runHealthCheck(store, client, { day: START, sleep: noSleep, maxAttempts: 3 });
    expect(summary.results[0]).toMatchObject({ attempts: 3, healthy: false, anomalies: ["CHECK_FAILED"], connection_status: "error" });
  });

  it("does not swallow non-transient errors", async () => {
    const store = memoryStore();
    store.upsert(account());
    const broken: PlatformClient = { fetchState: async () => { throw new Error("bug in adapter"); } };
    await expect(runHealthCheck(store, broken, { day: START, sleep: noSleep })).rejects.toThrow("bug in adapter");
  });

  it("only retries TransientPlatformError", async () => {
    const store = memoryStore();
    store.upsert(account());
    let calls = 0;
    const flaky: PlatformClient = {
      fetchState: async () => {
        calls++;
        if (calls === 1) throw new TransientPlatformError("timeout", 504);
        return healthyState();
      },
    };
    const summary = await runHealthCheck(store, flaky, { day: START, sleep: noSleep });
    expect(calls).toBe(2);
    expect(summary.results[0]?.message).toContain("HTTP 504");
  });

  it("keeps one row per account per day when a day is re-run", async () => {
    const store = memoryStore();
    store.upsert(account());
    await runHealthCheck(store, mock(), { day: START, sleep: noSleep });
    await runHealthCheck(store, mock(), { day: START, sleep: noSleep });
    expect(store.healthChecks()).toHaveLength(1);
  });

  it("does not let a re-run of an earlier day overwrite the account's latest state", async () => {
    const store = memoryStore();
    store.upsert(account());
    const client = mock([{ account_id: "LI-001", from_day: 2, to_day: 2, effect: "restricted" }]);
    await runHealthCheck(store, client, { day: "2026-01-02", sleep: noSleep });
    await runHealthCheck(store, client, { day: "2026-01-01", sleep: noSleep });
    expect(store.get("LI-001")?.status).toBe("restricted");
  });

  it("leaves the inventory baseline untouched so drift is detected on every day it persists", async () => {
    const store = memoryStore();
    store.upsert(account());
    const client = mock([{ account_id: "LI-001", from_day: 1, to_day: 2, effect: "permission_removed", value: "write" }]);
    await runHealthCheck(store, client, { day: "2026-01-01", sleep: noSleep });
    const day2 = await runHealthCheck(store, client, { day: "2026-01-02", sleep: noSleep });
    expect(store.get("LI-001")?.permissions).toEqual(["read", "write"]);
    expect(day2.results[0]?.anomalies).toEqual(["PERMISSION_MISSING"]);
  });
});

describe("mock platform scenarios", () => {
  it("computes 1-based day numbers from the monitoring start", () => {
    expect(dayNumber("2026-01-01", START)).toBe(1);
    expect(dayNumber("2026-01-05", START)).toBe(5);
  });

  it("applies an event only inside its day window", async () => {
    const client = mock([{ account_id: "LI-001", from_day: 2, to_day: 3, effect: "token_expired" }]);
    const at = (day: string) => client.fetchState(account(), { day, attempt: 1 });
    expect((await at("2026-01-01")).token_valid).toBe(true);
    expect((await at("2026-01-02")).token_valid).toBe(false);
    expect((await at("2026-01-03")).token_valid).toBe(false);
    expect((await at("2026-01-04")).token_valid).toBe(true);
  });
});
