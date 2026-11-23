import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const DIR = join(ROOT, ".github", "workflows");
const scripts = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
const read = (name: string) => readFileSync(join(DIR, name), "utf8");

/**
 * These cannot prove a workflow passes on GitHub - only a real run can.
 * They catch the mistakes that are cheap to catch locally: workflows in a
 * directory GitHub ignores, and steps that call npm scripts that do not exist.
 */
describe("GitHub Actions workflows", () => {
  it("live in .github/workflows, the only directory GitHub reads", () => {
    expect(existsSync(DIR)).toBe(true);
    expect(readdirSync(DIR).sort()).toEqual(["ci.yml", "daily-health-check.yml"]);
    expect(existsSync(join(ROOT, "github-workflows"))).toBe(false);
  });

  it.each(["ci.yml", "daily-health-check.yml"])("%s only calls npm scripts that exist", (name) => {
    const used = [...read(name).matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(0);
    for (const script of used) expect(scripts, `${name} calls "npm run ${script}"`).toHaveProperty(script);
  });

  it("ci.yml runs the type-check and the tests on push and pull request", () => {
    const yml = read("ci.yml");
    expect(yml).toMatch(/^on:\s*\n\s+push:/m);
    expect(yml).toContain("pull_request");
    expect(yml).toContain("npm run typecheck");
    expect(yml).toContain("npm test");
  });

  it("daily-health-check.yml is scheduled, can be run by hand and may push its reports", () => {
    const yml = read("daily-health-check.yml");
    expect(yml).toMatch(/cron: "0 8 \* \* \*"/);
    expect(yml).toContain("workflow_dispatch");
    expect(yml).toMatch(/permissions:\s*\n\s+contents: write/);
    expect(yml).toContain("npm run rebuild");
    expect(yml).toContain("npm run check");
  });
});
