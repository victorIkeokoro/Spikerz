import { describe, expect, it } from "vitest";
import { accountsToCsv, importAccounts, parseCsv, parseInventory } from "../src/importer.js";
import { memoryStore } from "./helpers.js";

const HEADER =
  "account_id,platform,account_type,environment,owner,status,connection_status,connected_assets,permissions,last_health_check,notes,credential_ref_id";

describe("parseCsv", () => {
  it("handles quoted fields, embedded commas, escaped quotes and CRLF", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
    ]);
  });
});

describe("inventory import", () => {
  it("parses a CSV inventory, splitting list cells on ;", () => {
    const csv = `${HEADER}\nIG-001,Instagram,business,qa,qa-team,active,pending,ig:a;page:b,instagram_basic;instagram_manage_comments,,"note, with comma",CRED-IG-001\n`;
    const [a] = parseInventory(csv, "csv");
    expect(a?.connected_assets).toEqual(["ig:a", "page:b"]);
    expect(a?.permissions).toEqual(["instagram_basic", "instagram_manage_comments"]);
    expect(a?.notes).toBe("note, with comma");
    expect(a?.last_health_check).toBeNull();
  });

  it("parses a JSON inventory in both supported shapes", () => {
    const row = { account_id: "X-001", platform: "X", credential_ref_id: "CRED-X-001", permissions: ["tweet.read"] };
    expect(parseInventory(JSON.stringify([row]), "json")[0]?.permissions).toEqual(["tweet.read"]);
    expect(parseInventory(JSON.stringify({ accounts: [row] }), "json")).toHaveLength(1);
  });

  it("refuses an inventory that carries a secret column", () => {
    const csv = `account_id,platform,password,credential_ref_id\nX-001,X,hunter2,CRED-X-001\n`;
    expect(() => parseInventory(csv, "csv")).toThrow(/Secrets must not be stored/);
  });

  it.each(["accessToken", "authToken", "sessionCookie", "passwordHash", "apiKey", "API_KEY", "private-key", "pwd", "sessionId"])(
    "rejects the secret-like %s column regardless of naming convention",
    (field) => {
      const csv = `account_id,platform,${field},credential_ref_id\nX-001,X,sensitive-value,CRED-X-001\n`;
      expect(() => parseInventory(csv, "csv")).toThrow(/Secrets must not be stored/);
    }
  );

  it("rejects unknown columns instead of silently dropping them", () => {
    const csv = `account_id,platform,credential_ref_id,login_hint\nX-001,X,CRED-X-001,whatever\n`;
    expect(() => parseInventory(csv, "csv")).toThrow(/unknown field\(s\): login_hint/);
    expect(() => parseInventory(JSON.stringify([{ account_id: "X-001", platform: "X", credential_ref_id: "C", extra: 1 }]), "json")).toThrow(
      /unknown field\(s\): extra/
    );
  });

  it("reports invalid rows without aborting the valid ones", () => {
    const store = memoryStore();
    const csv = `${HEADER}\nX-001,X,profile,qa,qa,active,pending,,,,,CRED-X-001\nBAD-1,Myspace,profile,qa,qa,active,pending,,,,,CRED-B\n`;
    const summary = importAccounts(store, parseInventory(csv, "csv"));
    expect(summary.created).toBe(1);
    expect(summary.failed).toEqual([expect.objectContaining({ account_id: "BAD-1" })]);
    expect(store.count()).toBe(1);
  });

  it("is idempotent: re-importing updates instead of duplicating", () => {
    const store = memoryStore();
    const accounts = parseInventory(`${HEADER}\nX-001,X,profile,qa,qa,active,pending,,,,,CRED-X-001\n`, "csv");
    importAccounts(store, accounts);
    const again = importAccounts(store, accounts);
    expect(again).toMatchObject({ created: 0, updated: 1 });
    expect(store.count()).toBe(1);
  });

  it("round-trips through CSV export", () => {
    const store = memoryStore();
    const csv = `${HEADER}\nFB-002,Facebook,page,qa,qa-team,active,connected,page:Mock A,pages_show_list;pages_manage_posts,,"a ""quoted"" note",CRED-FB-002\n`;
    importAccounts(store, parseInventory(csv, "csv"));
    const exported = accountsToCsv(store.list());
    expect(parseInventory(exported, "csv")).toEqual(store.list());
  });
});
