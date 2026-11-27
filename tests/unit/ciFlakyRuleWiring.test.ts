import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** ORW-229 flaky-test rule (docs/CI.md): pins where CI retries once, where flakes are reported, and that only the nightly run un-quarantines. */
const read = (p: string): string => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), "utf8");
const ci = read(".github/workflows/ci.yml");
const nightly = read(".github/workflows/ci-nightly.yml");

describe("flaky-test rule wiring", () => {
  it("the engine unit lane (which also collects coverage since ORW-413 PR 2) retries a failed test once and keeps the flaky reporter; the seeded heavy sims never retry", () => {
    expect(ci).toMatch(/--shard=\$\{\{ matrix\.shard \}\}\/10 --reporter=default --reporter=\.\/tests\/support\/flakyReporter\.ts --reporter=blob --outputFile\.blob=\.vitest-reports\/blob-\$\{\{ matrix\.shard \}\}\.json --retry=1/);
    expect(ci).not.toContain("coverage-shard:");
    expect(ci).toContain('npm run "test:heavy:$s" || {');
    expect(ci).not.toMatch(/test:heavy:\$s" -- --retry/);
  });
  it("the unit leg excludes exactly the heavy sims `npm run test:unit:fast` excludes (tests/uat/** and the juryReach and calibration property files), so none runs twice or is dropped", () => {
    const excludes = (text: string): string[] => [...text.matchAll(/--exclude '([^']+)'/g)].map((m) => m[1]!).sort();
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    const fast = excludes(pkg.scripts["test:unit:fast"]!);
    const shardLine = ci.split("\n").find((l) => l.includes("--exclude 'tests/uat/**'") && !l.includes("test:heavy"))!;
    expect(shardLine, "the engine unit shard command has its --exclude list").toBeDefined();
    expect(fast).toContain("tests/uat/**");
    expect(fast).toContain("tests/calibration/**");
    expect(fast.filter((x) => x.startsWith("tests/property/")).length).toBeGreaterThanOrEqual(6);
    expect(excludes(shardLine)).toEqual(fast);
  });
  it("a retried property test replays the same fast-check seed (review MEDIUM, tests/unit/fastCheckSeedReplay.test.ts)", () => {
    expect(read("vitest.config.ts")).toMatch(/setupFiles: \[[^\]]*"tests\/support\/fastCheckSeed\.ts"[^\]]*\]/);
  });
  it("both pytest lanes rerun a failed test once", () => {
    // ORW-218: the fe-unit shards also collect coverage (--cov --cov-report=), between -n 4 and --reruns 1; the rerun-once behaviour is the point of this pin.
    expect(ci).toContain('python3 -m pytest tests/ -m "not browser" -n 4 --cov --cov-report= --reruns 1');
    expect(ci).toContain("python3 -m pytest tests/ -m browser -n 3 --dist loadgroup --reruns 1");
  });
  it("the flake reporter is on in GitHub Actions, and every mirror gate counts a late pass", () => {
    expect(read("vitest.config.ts")).toContain('reporters: process.env.GITHUB_ACTIONS === "true" ? ["default", "./tests/support/flakyReporter.ts"] : ["default"]');
    expect(ci.match(/passed only on attempt \$attempt, counted as a flake/g)?.length).toBe(3);
  });
  it("quarantined tests run only in the nightly workflow", () => {
    expect(ci).not.toContain("ORWELL_RUN_QUARANTINED");
    expect(nightly).toMatch(/\nenv:\n(?: {2}.*\n)*? {2}ORWELL_RUN_QUARANTINED: "1"\n/);
    expect(nightly).toMatch(/schedule:\n {4}- cron: /);
    expect(nightly).toContain("runs-on: ubuntu-24.04");
    // both guards run every night, so an expired quarantine is caught even when no PR runs that lane (review LOW)
    expect(nightly).toContain("run: npx vitest run tests/unit/ciQuarantineGuard.test.ts");
    expect(nightly).toContain("python3 -m pytest tests/test_ci_quarantine_guard.py -q");
  });
});
