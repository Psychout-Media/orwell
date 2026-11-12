import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** ORW-229 flaky-test rule (docs/CI.md): pins where CI retries once, where flakes are reported, and that only the nightly run un-quarantines. */
const read = (p: string): string => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), "utf8");
const ci = read(".github/workflows/ci.yml");
const nightly = read(".github/workflows/ci-nightly.yml");

describe("flaky-test rule wiring", () => {
  it("the engine unit and coverage lanes retry a failed test once; the seeded heavy sims never retry", () => {
    expect(ci).toContain("npm run test:unit:fast -- --shard=${{ matrix.shard }}/5 --retry=1");
    expect(ci).toMatch(/--reporter=blob --outputFile=\.vitest-reports\/blob-\$\{\{ matrix\.shard \}\}\.json --retry=1/);
    expect(ci).toContain('npm run "test:heavy:$s" || {');
    expect(ci).not.toMatch(/test:heavy:\$s" -- --retry/);
  });
  it("a retried property test replays the same fast-check seed (review MEDIUM, tests/unit/fastCheckSeedReplay.test.ts)", () => {
    expect(read("vitest.config.ts")).toMatch(/setupFiles: \[[^\]]*"tests\/support\/fastCheckSeed\.ts"[^\]]*\]/);
  });
  it("both pytest lanes rerun a failed test once", () => {
    expect(ci).toContain('python3 -m pytest tests/ -m "not browser" -n 4 --reruns 1');
    expect(ci).toContain("python3 -m pytest tests/ -m browser --reruns 1");
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
