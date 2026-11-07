import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** ORW-229 flaky-test rule (docs/CI.md): pins where CI retries once, where flakes are reported, and that only the nightly run un-quarantines. */
const read = (p: string): string => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), "utf8");
const ci = read(".github/workflows/ci.yml");
const nightly = read(".github/workflows/ci-nightly.yml");

describe("flaky-test rule wiring", () => {
  it("every engine vitest lane retries a failed test once", () => {
    expect(ci).toContain("npm run test:unit:fast -- --shard=${{ matrix.shard }}/4 --retry=1");
    expect(ci).toMatch(/--reporter=blob --outputFile=\.vitest-reports\/blob-\$\{\{ matrix\.shard \}\}\.json --retry=1/);
    expect(ci).toContain('npm run "test:heavy:$s" -- --retry=1');
  });
  it("both pytest lanes rerun a failed test once", () => {
    expect(ci).toContain('python3 -m pytest tests/ -m "not browser" -n 4 --reruns 1');
    expect(ci).toContain("python3 -m pytest tests/ -m browser --reruns 1");
  });
  it("the flake reporter is on in GitHub Actions, and every mirror gate counts a late pass", () => {
    expect(read("vitest.config.ts")).toContain('reporters: process.env.GITHUB_ACTIONS === "true" ? ["default", "./tests/support/flakyReporter.ts"] : ["default"]');
    expect(ci.match(/passed only on attempt \$attempt, counted as a flake/g)?.length).toBe(6);
  });
  it("quarantined tests run only in the nightly workflow", () => {
    // ci.yml turns them on only when ci-nightly.yml calls it with `nightly: true` (a caller's env does not reach a called workflow).
    expect(ci.match(/ORWELL_RUN_QUARANTINED/g)?.length).toBe(1);
    expect(ci).toContain("ORWELL_RUN_QUARANTINED: ${{ inputs.nightly && '1' || '' }}");
    expect(nightly).toMatch(/\nenv:\n(?: {2}.*\n)*? {2}ORWELL_RUN_QUARANTINED: "1"\n/);
    expect(nightly).toMatch(/schedule:\n {4}- cron: /);
    expect(nightly).toContain("runs-on: ubuntu-24.04");
  });
});
