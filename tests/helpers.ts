import { openDb } from "../src/db.js";
import { Store } from "../src/store.js";
import type { Account } from "../src/types.js";

export function memoryStore(): Store {
  return new Store(openDb(":memory:"));
}

export function account(overrides: Partial<Account> = {}): Account {
  return {
    account_id: "LI-001",
    platform: "LinkedIn",
    account_type: "page",
    environment: "qa",
    owner: "qa-team",
    status: "active",
    connection_status: "connected",
    connected_assets: ["page:A"],
    permissions: ["read", "write"],
    last_health_check: null,
    notes: "",
    credential_ref_id: "CRED-LI-001",
    ...overrides,
  };
}

export const noSleep = async (): Promise<void> => {};
