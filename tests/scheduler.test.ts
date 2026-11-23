import { describe, expect, it, vi } from "vitest";
import { scheduleDaily } from "../src/scheduler.js";

describe("scheduler", () => {
  it("rejects an invalid cron expression", () => {
    expect(() => scheduleDaily("not a cron", async () => {})).toThrow(/invalid cron expression/);
  });

  it("registers a task for a valid expression without running the job immediately", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const job = vi.fn(async () => {});
    const task = scheduleDaily("0 8 * * *", job);
    expect(job).not.toHaveBeenCalled();
    await task.destroy();
    log.mockRestore();
  });
});
