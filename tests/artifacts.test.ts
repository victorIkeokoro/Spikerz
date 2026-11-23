import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rebuildState, writeDailyReports, writeSummaryArtifacts, type Paths } from "../src/artifacts.js";
import { runHealthCheck } from "../src/healthcheck.js";
import { MockPlatformClient } from "../src/platform.js";
import { memoryStore, noSleep } from "./helpers.js";

const SEED =
  "account_id,platform,account_type,environment,owner,status,connection_status,connected_assets,permissions,last_health_check,notes,credential_ref_id\n" +
  "X-001,X,profile,qa,qa,active,pending,x:h,tweet.read,,,CRED-X-001\n";

function workspace(): Paths {
  const dir = mkdtempSync(join(tmpdir(), "qa-accounts-"));
  const paths: Paths = {
    seed: join(dir, "seed.csv"),
    actions: join(dir, "actions.json"),
    reportsDir: join(dir, "reports"),
    docsDir: join(dir, "docs"),
    exportsDir: join(dir, "exports"),
  };
  writeFileSync(paths.seed, SEED);
  writeFileSync(
    paths.actions,
    JSON.stringify([{ day: "2026-01-01", account_id: "X-001", kind: "connect", actor: "victor", detail: "connected", evidence: "shot.png" }])
  );
  return paths;
}

describe("artifacts and state rebuild", () => {
  it("rebuilds the full database from the tracked files alone", async () => {
    const paths = workspace();
    const first = memoryStore();
    rebuildState(first, paths);
    const client = new MockPlatformClient({
      monitoring_start: "2026-01-01",
      events: [{ account_id: "X-001", from_day: 2, to_day: 2, effect: "disconnected" }],
    });
    for (const day of ["2026-01-01", "2026-01-02"]) {
      await runHealthCheck(first, client, { day, sleep: noSleep });
      writeDailyReports(first, day, paths);
    }

    const fresh = memoryStore();
    const result = rebuildState(fresh, paths);
    expect(result).toEqual({ accounts: 1, checks: 2, actions: 1 });
    expect(fresh.healthChecks()).toEqual(first.healthChecks().map((r) => ({ ...r, id: expect.any(Number) })));
    expect(fresh.get("X-001")?.connection_status).toBe("disconnected");
    expect(fresh.auditTrail().some((e) => e.action === "connect" && e.detail.includes("shot.png"))).toBe(true);
  });

  it("removes issue files that no longer correspond to an issue", async () => {
    const paths = workspace();
    const store = memoryStore();
    rebuildState(store, paths);
    await runHealthCheck(store, new MockPlatformClient({ monitoring_start: "2026-01-01", events: [] }), { day: "2026-01-01", sleep: noSleep });
    mkdirSync(join(paths.docsDir, "issues"), { recursive: true });
    writeFileSync(join(paths.docsDir, "issues", "ISS-009.md"), "stale");
    writeFileSync(join(paths.docsDir, "issues", "notes.md"), "keep me");
    writeSummaryArtifacts(store, paths);
    expect(existsSync(join(paths.docsDir, "issues", "ISS-009.md"))).toBe(false);
    expect(existsSync(join(paths.docsDir, "issues", "notes.md"))).toBe(true);
  });

  it("writes the dashboard, final report, issue log, maintenance log and inventory export", async () => {
    const paths = workspace();
    const store = memoryStore();
    rebuildState(store, paths);
    await runHealthCheck(store, new MockPlatformClient({ monitoring_start: "2026-01-01", events: [] }), { day: "2026-01-01", sleep: noSleep });
    writeSummaryArtifacts(store, paths);
    for (const f of ["reports/dashboard.html", "reports/final-report.json", "docs/maintenance-log.md", "docs/issues/README.md", "exports/accounts-inventory.csv", "exports/accounts-inventory.json"]) {
      expect(existsSync(join(paths.reportsDir, "..", f))).toBe(true);
    }
    expect(readFileSync(join(paths.exportsDir, "accounts-inventory.csv"), "utf8")).toContain("CRED-X-001");
  });
});
