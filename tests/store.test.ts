import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/store.js";
import { account, memoryStore } from "./helpers.js";

describe("Store - account CRUD", () => {
  it("creates and reads back an account, preserving list fields", () => {
    const store = memoryStore();
    expect(store.upsert(account()).created).toBe(true);
    const a = store.get("LI-001");
    expect(a?.permissions).toEqual(["read", "write"]);
    expect(a?.connected_assets).toEqual(["page:A"]);
  });

  it("updates only the patched fields", () => {
    const store = memoryStore();
    store.upsert(account());
    const next = store.update("LI-001", { owner: "growth-qa", notes: "moved" });
    expect(next.owner).toBe("growth-qa");
    expect(store.get("LI-001")?.platform).toBe("LinkedIn");
  });

  it("rejects unknown platforms, statuses and missing credential references", () => {
    const store = memoryStore();
    expect(() => store.upsert(account({ platform: "Myspace" as never }))).toThrow(ValidationError);
    expect(() => store.upsert(account({ status: "banned" as never }))).toThrow(ValidationError);
    expect(() => store.upsert(account({ credential_ref_id: "" }))).toThrow(/credential_ref_id/);
  });

  it("throws when updating an account that does not exist", () => {
    expect(() => memoryStore().update("NOPE", { owner: "x" })).toThrow(/not found/);
  });

  it("filters by platform, status and connection status", () => {
    const store = memoryStore();
    store.upsert(account());
    store.upsert(account({ account_id: "X-001", platform: "X", connection_status: "disconnected" }));
    store.upsert(account({ account_id: "X-002", platform: "X", status: "restricted" }));
    expect(store.list({ platform: "X" })).toHaveLength(2);
    expect(store.list({ platform: "X", status: "restricted" }).map((a) => a.account_id)).toEqual(["X-002"]);
    expect(store.list({ connection_status: "disconnected" }).map((a) => a.account_id)).toEqual(["X-001"]);
  });

  it("deletes an account", () => {
    const store = memoryStore();
    store.upsert(account());
    expect(store.delete("LI-001")).toBe(true);
    expect(store.delete("LI-001")).toBe(false);
    expect(store.count()).toBe(0);
  });

  it("retires an account without deleting its record", () => {
    const store = memoryStore();
    store.upsert(account());
    store.retire("LI-001", "victor");
    const a = store.get("LI-001");
    expect(a?.status).toBe("retired");
    expect(a?.connection_status).toBe("disconnected");
  });
});

describe("Store - audit trail", () => {
  it("records who changed what, including old and new values", () => {
    const store = memoryStore();
    store.upsert(account(), "alice");
    store.update("LI-001", { owner: "growth-qa" }, "bob");
    const trail = store.auditTrail("LI-001");
    expect(trail.map((e) => [e.action, e.actor])).toEqual([
      ["create", "alice"],
      ["update", "bob"],
    ]);
    expect(trail[1]?.detail).toContain('owner: "qa-team" -> "growth-qa"');
    expect(trail.every((e) => !Number.isNaN(Date.parse(e.at)))).toBe(true);
  });
});
