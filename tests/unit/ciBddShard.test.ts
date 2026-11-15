import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain .mjs script, no type declarations
import { assignBddShards, featurePaths, loadDurations, MIN_WEIGHT_S } from "../../ci/bdd-shard.mjs";

/** ORW-413: the BDD gate runs in three legs (ci/bdd-shard.mjs). Every executable feature must run in exactly one leg, and the legs must be balanced on measured seconds. */
const files: string[] = featurePaths();
const durations: Record<string, number> = loadDurations();
const w = (f: string): number => Math.max(MIN_WEIGHT_S, durations[f] ?? 0);

describe("BDD shard assignment (ORW-413)", () => {
  it("reads the executable features from cucumber.cjs", () => expect(files.length).toBeGreaterThan(100));

  for (const count of [1, 2, 3, 4]) {
    it(`${count} legs: every feature is in exactly one leg (none dropped, none twice)`, () => {
      const legs: string[][] = assignBddShards(files, durations, count);
      expect(legs).toHaveLength(count);
      expect(legs.flat().sort()).toEqual([...new Set(files)].sort());
    });
  }

  it("is deterministic", () => expect(assignBddShards([...files].reverse(), durations, 3)).toEqual(assignBddShards(files, durations, 3)));

  it("a feature with no measured entry only warns (it weighs the median), it never fails a PR (refresh from the `[bdd-shard] <feature> <seconds>` lines of a green run)", () => {
    const missing = files.filter((f) => durations[f] === undefined);
    if (missing.length > 0) console.warn(`::warning::${missing.length} feature(s) not in ci/bdd-durations.json (weighed at the median): ${missing.slice(0, 10).join(", ")}`);
    expect((assignBddShards(files, durations, 3) as string[][]).flat().length).toBe(files.length);
  });

  it("the three legs are balanced: heaviest <= 1.15 x the mean (or the mean plus the heaviest single feature)", () => {
    const loads = (assignBddShards(files, durations, 3) as string[][]).map((l) => l.reduce((n, f) => n + w(f), 0));
    const mean = loads.reduce((a, b) => a + b, 0) / 3;
    expect(Math.max(...loads)).toBeLessThanOrEqual(Math.max(mean * 1.15, mean + Math.max(...files.map(w)) / 2));
  });

  it("ci.yml runs the three legs and the cucumber paths are the only feature list", () => {
    const ci = readFileSync(fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url)), "utf8");
    expect(ci).toContain("node ci/bdd-shard.mjs ${{ matrix.shard }}/3");
    expect(ci).toMatch(/name: bdd \(\$\{\{ matrix\.shard \}\}\/3\)/);
  });
});
