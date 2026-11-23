/**
 * Produce the full five-day dataset and every report artifact.
 *
 *   npm run generate:5day
 *
 * 1. Rebuilds the database from the tracked files (seed inventory, recorded
 *    actions, any daily JSON reports already present).
 * 2. For each of the five monitoring days, keeps the stored result if that day
 *    was already checked LIVE; otherwise runs the health-check engine with a
 *    simulated clock for that day.
 * 3. Regenerates daily reports, dashboard, final report, issue log,
 *    maintenance log and inventory export.
 */
import "dotenv/config";
import { rebuildState, writeDailyReports, writeSummaryArtifacts } from "../src/artifacts.js";
import { openDb } from "../src/db.js";
import { runHealthCheck } from "../src/healthcheck.js";
import { MockPlatformClient, addDays, loadScenarios } from "../src/platform.js";
import { Store } from "../src/store.js";

const DAYS = 5;
const store = new Store(openDb(process.env.QA_DB_PATH ?? "./data/qa.db"));
const scenarios = loadScenarios(process.env.QA_SCENARIOS ?? "data/mock-scenarios.json");
const client = new MockPlatformClient(scenarios);

const rebuilt = rebuildState(store);
console.log(`Rebuilt state: ${rebuilt.accounts} accounts, ${rebuilt.actions} recorded actions, ${rebuilt.checks} existing check rows`);

for (let i = 0; i < DAYS; i++) {
  const day = addDays(scenarios.monitoring_start, i);
  const existing = store.healthChecks({ day });
  if (existing.length > 0 && existing.every((r) => r.run_mode === "live")) {
    console.log(`Day ${i + 1} ${day}: keeping ${existing.length} live result(s)`);
  } else {
    const s = await runHealthCheck(store, client, {
      day,
      runMode: "simulated-clock",
      now: () => new Date(`${day}T12:00:00.000Z`),
      sleep: async () => {},
    });
    console.log(`Day ${i + 1} ${day}: simulated-clock run - ${s.healthy} healthy, ${s.warning} warning, ${s.failing} failing`);
  }
  writeDailyReports(store, day);
}

const files = writeSummaryArtifacts(store);
console.log(`Wrote ${files.length} summary artifact(s). Open reports/dashboard.html`);
