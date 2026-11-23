import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * End-to-end tests of the real CLI: each test spawns `tsx src/cli.ts` in a
 * throwaway working directory that holds its own copy of the data files and
 * its own SQLite database, so nothing in the repository is touched.
 */
const ROOT = join(import.meta.dirname, "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");

let cwd: string;

function cli(...args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, [TSX, CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, QA_DB_PATH: join(cwd, "data", "qa.db"), QA_ACTOR: "cli-test", QA_ALERT_WEBHOOK_URL: "" },
  });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), "qa-cli-"));
  cpSync(join(ROOT, "data", "accounts.seed.csv"), join(cwd, "data", "accounts.seed.csv"), { recursive: true });
  cpSync(join(ROOT, "data", "mock-scenarios.json"), join(cwd, "data", "mock-scenarios.json"));
  writeFileSync(join(cwd, "data", "maintenance-actions.json"), "[]\n");
});

describe("CLI end to end", () => {
  it("refuses to run a check on an empty inventory", () => {
    const r = cli("check", "run", "--date", "2026-11-23");
    expect(r.code).toBe(1);
    expect(r.err).toContain("inventory is empty");
  });

  it("imports the seed inventory and lists it with filters", () => {
    expect(cli("account", "import", "--file", "data/accounts.seed.csv").out).toContain("15 created, 0 updated, 0 failed");
    const all = JSON.parse(cli("account", "list", "--json").out.replace(/\n\d+ account\(s\)\s*$/, "")) as unknown[];
    expect(all).toHaveLength(15);
    expect(cli("account", "list", "--platform", "TikTok").out).toContain("3 account(s)");
  });

  it("adds, updates and views an account, recording the actor in the audit trail", () => {
    expect(cli("account", "add", "--id", "X-004", "--platform", "X", "--cred-ref", "CRED-X-004", "--permissions", "tweet.read;users.read").code).toBe(0);
    expect(cli("--actor", "victor", "account", "update", "X-004", "--owner", "growth-qa").code).toBe(0);
    const viewed = JSON.parse(cli("account", "view", "X-004").out) as { owner: string; permissions: string[] };
    expect(viewed).toMatchObject({ owner: "growth-qa", permissions: ["tweet.read", "users.read"] });
    const audit = cli("audit", "--account", "X-004").out;
    expect(audit).toContain("victor");
    expect(audit).toContain("cli-test");
  });

  it("exits non-zero with a clear message on invalid input", () => {
    const bad = cli("account", "add", "--id", "BAD-1", "--platform", "Myspace", "--cred-ref", "C");
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('invalid platform "Myspace"');
    const dup = cli("account", "add", "--id", "X-004", "--platform", "X", "--cred-ref", "C");
    expect(dup.code).toBe(1);
    expect(dup.err).toContain("already exists");
  });

  it("rejects an inventory file that carries a secret column", () => {
    writeFileSync(join(cwd, "leaky.csv"), "account_id,platform,accessToken,credential_ref_id\nX-009,X,abc123,CRED-X-009\n");
    const r = cli("account", "import", "--file", "leaky.csv");
    expect(r.code).not.toBe(0);
    expect(r.out + r.err).toContain("Secrets must not be stored");
    expect(cli("account", "view", "X-009").code).toBe(1);
  });

  it("runs a health check for a given day and writes every report file", () => {
    const r = cli("check", "run", "--date", "2026-11-25");
    expect(r.code).toBe(0);
    expect(r.out).toContain("simulated-clock");
    expect(r.out).toContain("TOKEN_EXPIRED");
    for (const f of ["reports/daily/health-2026-11-25.json", "reports/daily/health-2026-11-25.csv", "reports/dashboard.html", "reports/final-report.json", "docs/maintenance-log.md", "docs/issues/README.md", "data/exports/accounts-inventory.csv"]) {
      expect(existsSync(join(cwd, f)), f).toBe(true);
    }
    const daily = JSON.parse(readFileSync(join(cwd, "reports/daily/health-2026-11-25.json"), "utf8")) as { totals: { accounts: number; failing: number } };
    expect(daily.totals.accounts).toBe(16);
    expect(daily.totals.failing).toBeGreaterThan(0);
  });

  it("records a maintenance action in both the audit trail and the tracked actions file", () => {
    expect(cli("maintenance", "add", "--account", "LI-002", "--note", "Re-authorised", "--date", "2026-11-25").code).toBe(0);
    const actions = JSON.parse(readFileSync(join(cwd, "data/maintenance-actions.json"), "utf8")) as Array<{ account_id: string; actor: string }>;
    expect(actions).toEqual([expect.objectContaining({ account_id: "LI-002", kind: "maintenance", actor: "cli-test" })]);
    expect(cli("maintenance", "add", "--account", "NOPE", "--note", "x").code).toBe(1);
  });

  it("retires an account so later checks skip it", () => {
    expect(cli("account", "retire", "X-004").code).toBe(0);
    const r = cli("check", "run", "--date", "2026-11-26", "--no-reports");
    expect(r.out).toContain("15 checked");
    expect(r.out).not.toContain("X-004");
  });

  it("shows credential presence without printing any secret value", () => {
    const r = spawnSync(process.execPath, [TSX, CLI, "creds"], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, QA_DB_PATH: join(cwd, "data", "qa.db"), QA_CRED_LI_001: "super-secret-value" },
    });
    expect(r.stdout).toContain("QA_CRED_LI_001");
    expect(r.stdout).not.toContain("super-secret-value");
  });
});
