import cron from "node-cron";

/**
 * Run `job` on a cron schedule inside a long-lived process.
 * For unattended use prefer the GitHub Actions schedule in
 * .github/workflows/daily-health-check.yml or a system crontab entry:
 *
 *   0 8 * * *  cd /path/to/repo && npm run cli -- check run
 */
export function scheduleDaily(expression: string, job: () => Promise<void>): void {
  if (!cron.validate(expression)) throw new Error(`invalid cron expression "${expression}"`);
  cron.schedule(
    expression,
    () => {
      job().catch((err) => console.error(`[scheduler] run failed: ${(err as Error).message}`));
    },
    { timezone: "UTC" }
  );
  console.log(`[scheduler] daily health check scheduled with "${expression}" (UTC). Ctrl+C to stop.`);
}
