import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  SEEDS,
  shardRange,
  playSeeds,
  assertBand,
  type SeasonResult,
} from "./juryReachShared";

/**
 * D4/E33 — the jury-reach calibration gate, SHARD RUNNER (audit 2026-06-10, Theme 5; round-4 R5
 * → round-6 R11; sharded 2026-06-19 for CI wall-clock).
 *
 * Round 4 measured 62/62 passive seeded seasons ending in a pre-jury player eviction — the jury,
 * the finale, the juror's seat, and eviction night were unreachable content in practice. Round 6
 * (R11) reframed it: the ladder works; the survival rate is a CALIBRATION property that needs a
 * permanent gate. This is that gate.
 *
 * Methodology (unchanged): seeded multi-season runs through the LIVE loop — the same runtime
 * composition `main.ts` uses (composeRuntime → registry → orchestrator commit spine, pure
 * turn-driven, one bounded off-screen tick per beat) — driven by a PASSIVE player policy (no
 * social game, every engine pending answered minimally). The player's outcome is read from the
 * PUBLIC 0046 seam (`GameStateView.player.status`). See {@link file://./juryReachShared.ts} for
 * the driver + the canonical band, and the spec headers there for the FLOOR/CEILING rationale.
 *
 * **Sharding (the ONLY structural change):** the 20 seasons are independent and per-season seeded,
 * so the play fans out across CI runners. This file is now a SHARD RUNNER: with `JURY_SHARDS=N`
 * (and `JURY_SHARD=k`) it plays ONLY its contiguous seed slice `[shardRange(k,N))` and writes the
 * per-season measurements to a JSON artifact — it makes NO band assertion (a slice can't see the
 * distribution). The full-20 band is asserted by the dependent AGGREGATE test
 * (`juryReachAggregate.property.test.ts`), which downloads every shard artifact and recombines.
 *
 * UNSHARDED (no `JURY_SHARDS`, the local `npm run test:heavy:jury` path) it plays ALL 20 seeds and
 * runs the band assertion inline — so a single local run still gates the full property exactly as
 * before. Bands and seed count are IDENTICAL to the pre-shard single-file gate; only WHERE the
 * seeds are played moved. The gate rides seeded determinism (same seeds ⇒ same outcomes), so a
 * failure is always a REAL behavior change in the nomination/vote/relationship calibration, never
 * noise. Roles only — no houseguest names.
 */

const SHARDS = Number(process.env.JURY_SHARDS ?? "0"); // 0/unset ⇒ run the whole set in this process
const SHARD = Number(process.env.JURY_SHARD ?? "0");
// Where a shard drops its results for the aggregate to collect (CI uploads this dir as an artifact).
const RESULTS_DIR = process.env.JURY_RESULTS_DIR ?? join("tmp", "jury-shards");

function writeShardResults(shard: number, results: SeasonResult[]): string {
  const path = join(RESULTS_DIR, `jury-shard-${shard}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ shard, results }, null, 2));
  return path;
}

if (SHARDS >= 1) {
  const { from, to } = shardRange(SHARD, SHARDS);
  const slice = `[${from}, ${to})`; // inclusive-exclusive seed slice this shard owns
  describe(`D4/E33 — jury-reach shard ${SHARD}/${SHARDS} (plays seeds ${slice}, no band assertion)`, () => {
    it(
      `plays passive seasons for seeds ${slice} and emits results for the aggregate`,
      { timeout: 600_000 }, // a shard plays a SLICE of the ~20 full seasons; generous for loaded CI hosts
      async () => {
        const results = await playSeeds(from, to);
        const path = writeShardResults(SHARD, results);
        // A shard ONLY produces results — the distribution band is the aggregate's job. The single
        // structural check here: the slice produced exactly the seasons it owns, all finished
        // (playSeeds throws on an unfinished season), so the artifact is complete.
        expect(results.map((r) => r.seed), `shard ${SHARD}/${SHARDS} → ${path}`).toEqual(
          Array.from({ length: to - from }, (_, i) => from + i),
        );
      },
    );
  });
} else {
  describe("D4/E33 — a passive player's structural reach of the jury (calibration gate, unsharded)", () => {
    it(
      `across ${SEEDS} passive seeded live seasons, the player reaches the jury within the calibration band`,
      { timeout: 600_000 }, // ~20 full live seasons; generous for loaded CI hosts (same family as the UAT)
      async () => {
        const results = await playSeeds(1, SEEDS + 1);
        // Local/unsharded: play all 20 and run THE aggregate band inline — identical to the
        // pre-shard single-file gate.
        assertBand(results, expect as never);
      },
    );
  });
}
