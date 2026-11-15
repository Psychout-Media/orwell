import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

  it("the three legs are balanced: heaviest <= 1.15 x the mean (or the mean plus half the heaviest single feature)", () => {
    const loads = (assignBddShards(files, durations, 3) as string[][]).map((l) => l.reduce((n, f) => n + w(f), 0));
    const mean = loads.reduce((a, b) => a + b, 0) / 3;
    expect(Math.max(...loads)).toBeLessThanOrEqual(Math.max(mean * 1.15, mean + Math.max(...files.map(w)) / 2));
  });

  it("the leg really reaches cucumber: ORWELL_BDD_FEATURES replaces cucumber.cjs's path list (a broken override would run every feature in every leg), and the shard script sets it", () => {
    const load = (env: Record<string, string>): string[] => {
      const r = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(require('./cucumber.cjs').default.paths))"], { cwd: fileURLToPath(new URL("../..", import.meta.url)), env: { ...process.env, ORWELL_BDD_FEATURES: "", ...env }, encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      return JSON.parse(r.stdout);
    };
    expect(load({ ORWELL_BDD_FEATURES: "docs/features/a.feature\ndocs/features/b.feature\n" })).toEqual(["docs/features/a.feature", "docs/features/b.feature"]);
    expect(load({}).length, "unset: the full executable list").toBe(files.length);
    const script = readFileSync(fileURLToPath(new URL("../../ci/bdd-shard.mjs", import.meta.url)), "utf8");
    expect(script).toMatch(/ORWELL_BDD_FEATURES: files\.join\("\\n"\)/);
    expect(script, "an empty leg would run everything, so the script refuses it").toContain("an empty leg would run every feature");
  });

  it("ci.yml runs the three legs and the cucumber paths are the only feature list", () => {
    const ci = readFileSync(fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url)), "utf8");
    expect(ci).toContain("node ci/bdd-shard.mjs ${{ matrix.shard }}/3");
    expect(ci).toMatch(/name: bdd \(\$\{\{ matrix\.shard \}\}\/3\)/);
  });
});
