import { describe, it, expect } from "vitest";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { playSeason, summarize, type Arm as AnyArm, type SeasonMetrics } from "./calibrationArms";

/** The standing PO gate measures the three original arms only; the jury-managing `managed` arm (A1) is an instrument-only arm. */
type Arm = Exclude<AnyArm, "managed">;
import { poViolations } from "./poTargetBands";

/**
 * PO-TARGET calibration gate (the replacement for the loose "minimal-active >= passive over 6 seeds" gradient claim).
 * Plays the passive / solid / reckless arms over the SAME seeds on the DEFAULT flag profile (the game that ships) and asserts
 * the owner's bands (`poTargetBands.ts`, from the 2026-11-02 rulings). 300 seeds x 3 arms is about 80 CPU-minutes, so it
 * also shards: the seasons are independent and per-seed seeded, so a slice plays on its own runner and the recombined set is
 * identical to playing all of them in one process.
 *
 * Modes (env):
 *   (none)                         play ALL arms for seeds 1..ORWELL_PO_SEEDS (default 300) and assert the bands inline.
 *   ORWELL_PO_ARM=<arm>            SHARD: play only that arm for seeds [ORWELL_PO_FROM, ORWELL_PO_TO) and write
 *     ORWELL_PO_FROM / _TO / _OUT    <OUT>/po-<arm>-<from>-<to>.json. No band assertion (a slice cannot see the distribution).
 *   ORWELL_PO_AGG_DIR=<dir>        AGGREGATE: read every shard file under <dir>, require exactly seeds 1..N once per arm, assert.
 * Run: `npm run test:calib:po` (all-in-one). Not in the default unit suite (tests/calibration/** is excluded).
 */

const SEEDS = Number.parseInt(process.env.ORWELL_PO_SEEDS ?? "300", 10);
const ARM = process.env.ORWELL_PO_ARM as Arm | undefined;
const AGG = process.env.ORWELL_PO_AGG_DIR;
const ARMS: Arm[] = ["passive", "solid", "reckless"];

/** Seasons played per runtime. Every finished season keeps its sandbox alive in the registry, so one runtime over 75+ seasons grows until the
 *  worker is OOM-killed (seen on the 300-seed remote runs: "Worker exited unexpectedly"). A fresh runtime every few seasons bounds memory;
 *  each season is keyed by its seed and arm, so recycling the runtime changes no outcome. */
const SEASONS_PER_RUNTIME = 10;

async function playArm(arm: Arm, from: number, to: number): Promise<SeasonMetrics[]> {
  const rows: SeasonMetrics[] = [];
  for (let start = from; start < to; start += SEASONS_PER_RUNTIME) {
    const runtime = composeRuntime({ clock: new FakeClock(), seed: 1 });
    const resolver = runtime.registry.resolver();
    for (let seed = start; seed < Math.min(to, start + SEASONS_PER_RUNTIME); seed++) rows.push(await playSeason(resolver, seed, arm));
  }
  return rows;
}

function assertBands(rows: Record<Arm, SeasonMetrics[]>): void {
  for (const arm of ARMS) {
    const seeds = rows[arm].map((r) => r.seed).sort((a, b) => a - b);
    expect(seeds, `${arm}: exactly seeds 1..${SEEDS}, each once`).toEqual(Array.from({ length: SEEDS }, (_, i) => i + 1));
  }
  const summary = { passive: summarize("passive", rows.passive), solid: summarize("solid", rows.solid), reckless: summarize("reckless", rows.reckless) };
  expect(poViolations(summary), `PO targets over ${SEEDS} seeds on the default profile:\n${JSON.stringify(summary, null, 1)}`).toEqual([]);
}

if (AGG) {
  describe("PO-target calibration gate — AGGREGATE", () => {
    it("recombines every shard file and asserts the owner's bands", () => {
      const rows: Record<Arm, SeasonMetrics[]> = { passive: [], solid: [], reckless: [] };
      for (const name of readdirSync(AGG).filter((n) => /^po-(passive|solid|reckless)-\d+-\d+\.json$/.test(n)).sort()) {
        const f = JSON.parse(readFileSync(join(AGG, name), "utf8")) as { arm: Arm; rows: SeasonMetrics[] };
        rows[f.arm].push(...f.rows);
      }
      assertBands(rows);
    });
  });
} else if (ARM) {
  const from = Number.parseInt(process.env.ORWELL_PO_FROM ?? "1", 10);
  const to = Number.parseInt(process.env.ORWELL_PO_TO ?? String(SEEDS + 1), 10);
  describe(`PO-target calibration gate — shard ${ARM} [${from}, ${to})`, () => {
    it("plays its slice and writes the shard file", async () => {
      const rows = await playArm(ARM, from, to);
      const out = process.env.ORWELL_PO_OUT ?? join("tmp", "po-shards");
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, `po-${ARM}-${from}-${to}.json`), JSON.stringify({ arm: ARM, rows }));
      expect(rows.map((r) => r.seed)).toEqual(Array.from({ length: to - from }, (_, i) => from + i));
    }, { timeout: 3_600_000 });
  });
} else {
  describe("PO-target calibration gate (default profile, all arms, inline)", () => {
    it(`passive/solid/reckless over ${SEEDS} seeds hold Ryne's bands`, async () => {
      const rows = { passive: await playArm("passive", 1, SEEDS + 1), solid: await playArm("solid", 1, SEEDS + 1), reckless: await playArm("reckless", 1, SEEDS + 1) };
      assertBands(rows);
    }, { timeout: 4 * 3_600_000 }); // the serial all-in-one path is ~80 CPU-minutes; CI/nightly shard it (see the file header)
  });
}
