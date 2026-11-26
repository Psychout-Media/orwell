import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  SEEDS,
  shardRange,
  playSeeds,
  assertGradient,
  type GradientResult,
} from "./calibrationGradientShared";

/**
 * Calibration GRADIENT gate, SHARD RUNNER (calibration-instrumentation lane, 2026-06-19; sharded
 * 2026-06-19 for CI wall-clock).
 *
 * `juryReach.property.test.ts` gates the PASSIVE extreme only. This gate measures the GRADIENT: a
 * MINIMAL-ACTIVE policy (a few recorded social scenes + basic self-preservation) must reach the jury
 * AT LEAST AS OFTEN and win AT LEAST AS OFTEN as the fully-passive policy across the same seeded
 * seasons — the monotonic property that "playing the game is never WORSE than not playing it". See
 * {@link file://./calibrationGradientShared.ts} for the policy, driver, and canonical band, and its
 * spec header for the full rationale.
 *
 * **Sharding (the ONLY structural change):** each seed plays an independent, per-seed-seeded
 * passive+active PAIR, so the play fans out across CI runners. This file is now a SHARD RUNNER: with
 * `GRADIENT_SHARDS=N` (and `GRADIENT_SHARD=k`) it plays ONLY its contiguous seed slice
 * `[shardRange(k,N))` and writes the per-seed measurements to a JSON artifact — it makes NO band
 * assertion (a slice can't see the active-vs-passive distribution). The full band is asserted by the
 * dependent AGGREGATE test (`calibrationGradientAggregate.property.test.ts`), which downloads every
 * shard artifact and recombines.
 *
 * UNSHARDED (no `GRADIENT_SHARDS`, the local `npm run test:heavy:gradient` path) it plays ALL
 * {@link SEEDS} seeds and runs the band assertion inline — so a single local run still gates the
 * full property exactly as before. The policy, SEED count, and band are IDENTICAL to the pre-shard
 * single-file gate; only WHERE the seeds are played moved. It is a HEAVY simulation (two full-season
 * sweeps per seed). Roles only — no houseguest names.
 */

const SHARDS = Number(process.env.GRADIENT_SHARDS ?? "0"); // 0/unset ⇒ run the whole set in this process
const SHARD = Number(process.env.GRADIENT_SHARD ?? "0");
const RESULTS_DIR = process.env.GRADIENT_RESULTS_DIR ?? join("tmp", "gradient-shards");

function writeShardResults(shard: number, results: GradientResult[]): string {
  const path = join(RESULTS_DIR, `gradient-shard-${shard}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ shard, results }, null, 2));
  return path;
}

if (SHARDS >= 1) {
  const { from, to } = shardRange(SHARD, SHARDS);
  const slice = `[${from}, ${to})`; // inclusive-exclusive seed slice this shard owns
  describe(`calibration gradient — shard ${SHARD}/${SHARDS} (plays seeds ${slice}, no band assertion)`, () => {
    it(
      `plays passive+active sweeps for seeds ${slice} and emits results for the aggregate`,
      { timeout: 600_000 }, // a shard plays a SLICE of the 6 passive+active pairs; generous for loaded CI hosts
      async () => {
        const results = await playSeeds(from, to);
        const path = writeShardResults(SHARD, results);
        // A shard ONLY produces results — the active-vs-passive band is the aggregate's job. The
        // single structural check here: the slice produced exactly the seeds it owns (playSeeds
        // throws on an unfinished season), so the artifact is complete.
        expect(results.map((r) => r.seed), `shard ${SHARD}/${SHARDS} → ${path}`).toEqual(
          Array.from({ length: to - from }, (_, i) => from + i),
        );
      },
    );
  });
} else {
  describe("calibration gradient — minimal-active play reaches/wins at least as often as passive play (unsharded)", () => {
    it(
      `across ${SEEDS} seeded live seasons, active jury-reach ≥ passive and active wins ≥ passive`,
      { timeout: 600_000 }, // two full-season sweeps × SEEDS; generous for loaded CI hosts
      async () => {
        const results = await playSeeds(1, SEEDS + 1);
        // Local/unsharded: play all SEEDS and run THE aggregate band inline — identical to the
        // pre-shard single-file gate.
        assertGradient(results, expect as never);
      },
    );
  });
}
