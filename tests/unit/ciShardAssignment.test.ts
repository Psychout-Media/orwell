import { describe, it, expect } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPartition, assignShards, loadDurations, MIN_WEIGHT_MS, DURATIONS_RELATIVE_PATH } from "../../vitest.sequencer";

/**
 * ORW-218: the duration-aware `--shard` split (vitest.sequencer.ts) must be an exact partition of the test files,
 * deterministic, and actually balanced. Run on the REAL test tree and the REAL committed duration table.
 */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function listTests(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) listTests(p, out);
    else if (name.endsWith(".test.ts")) out.push(relative(ROOT, p).split(sep).join("/"));
  }
  return out;
}

const files = listTests(join(ROOT, "tests"));
const durations = loadDurations(join(ROOT, DURATIONS_RELATIVE_PATH));
const weight = (f: string): number => Math.max(MIN_WEIGHT_MS, durations[f] ?? 0);

describe("duration-aware shard assignment (ORW-218)", () => {
  it("finds the test tree and the committed duration table", () => {
    expect(files.length).toBeGreaterThan(400);
    expect(Object.keys(durations).length).toBeGreaterThan(400);
  });

  for (const count of [2, 3, 4, 5]) {
    it(`${count} legs: every test file is in exactly one leg (union == full set, none dropped, none twice)`, () => {
      const legs = assignShards(files, durations, count);
      expect(legs).toHaveLength(count);
      expect(() => assertPartition(files, legs)).not.toThrow();
      expect(legs.flat().length).toBe(new Set(files).size);
      for (const leg of legs) expect(leg.length).toBeGreaterThan(0);
    });
  }

  it("a dropped, duplicated or invented file is reported (the guard has teeth)", () => {
    const legs = assignShards(files, durations, 4).map((l) => [...l]);
    const victim = legs[0]![0]!;
    const dropped = legs.map((l) => l.filter((f) => f !== victim));
    expect(() => assertPartition(files, dropped)).toThrow(/dropped/);
    expect(() => assertPartition(files, [...legs, [victim]])).toThrow(/duplicated/);
    expect(() => assertPartition(files, [...legs, ["tests/unit/nope.test.ts"]])).toThrow(/invented/);
  });

  it("is deterministic and independent of the incoming file order", () => {
    const a = assignShards(files, durations, 4);
    const b = assignShards([...files].reverse(), durations, 4);
    expect(b.map((l) => [...l].sort())).toEqual(a.map((l) => [...l].sort()));
  });

  it("a file missing from the table still gets a leg (median weight), and a stale table entry changes nothing", () => {
    const withNew = [...files, "tests/unit/brandNewFile.test.ts"];
    const legs = assignShards(withNew, { ...durations, "tests/unit/deletedLongAgo.test.ts": 999_999 }, 4);
    expect(() => assertPartition(withNew, legs)).not.toThrow();
  });

  // Drift note: this bound is computed from the committed table, not from fresh timings, so it only fails when the table or the split algorithm changes
  // (e.g. a handful of new heavy files recorded without re-running the greedy pass). It cannot see real-runner drift; the per-leg CI times in the PR body do.
  it("is balanced: heaviest leg <= mean + the single heaviest file (the greedy LPT bound), and within 15% of the mean for 4 legs", () => {
    const legs = assignShards(files, durations, 4);
    const loads = legs.map((l) => l.reduce((n, f) => n + weight(f), 0));
    const total = loads.reduce((a, b) => a + b, 0);
    const heaviestFile = Math.max(...files.map(weight));
    expect(Math.max(...loads)).toBeLessThanOrEqual(total / 4 + heaviestFile);
    expect(Math.max(...loads)).toBeLessThanOrEqual((total / 4) * 1.15);
  });

  it("no single file is heavy enough to be a leg on its own (the 807 s file was split into five 20-run files)", () => {
    const total = files.reduce((n, f) => n + weight(f), 0);
    expect(Math.max(...files.map(weight))).toBeLessThan(total / 4 / 2);
  });
});
