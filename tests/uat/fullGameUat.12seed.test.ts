/**
 * tests/uat/fullGameUat.12seed.test.ts
 *
 * Heavy-sims lane: uat-12seed.
 *
 * The primary completion run — 12 seeds, never-use-veto, played to a winner via the
 * direct callTool path (no HTTP: the transport layer added non-deterministic overhead
 * that caused stale-loop failures in CI for some seeds). One of the three slices the
 * former single fullGameUat.test.ts was split into so its independent `it` blocks fan
 * out across separate CI runners; seeds and assertions are unchanged.
 *
 * **Seed-sharding (structural only):** this block asserts PER-SEED properties only (each game
 * finishes, no anomalies, ≥1 week played, and — over a non-empty slice — total player decisions
 * > 0); it runs NO cross-seed aggregate. So with `UAT12_SHARDS=N` (`UAT12_SHARD=k`) it plays ONLY
 * its contiguous seed slice and asserts INDEPENDENTLY over it — the union of the shards is the
 * full 12 seeds, each played exactly once, no assertion weakened. Unset (the local
 * `npm run test:heavy:uat-12seed` path) plays all 12. See {@link resolveUatSeedShard}.
 *
 * See tests/uat/fullGameUatHarness.ts for the shared driver + invariant checkers.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startUatHarness,
  runFullGameDirect,
  resolveUatSeedShard,
  type UatHarness,
  type RunResult,
} from "./fullGameUatHarness";

// The full seed set this block owns, and this process's shard slice of it (env-driven).
const ALL_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const { seeds: SEEDS, label: SHARD_LABEL } = resolveUatSeedShard(ALL_SEEDS);

describe(`full-game UAT — 12 seeds (never-use-veto) — ${SHARD_LABEL}`, () => {
  let harness: UatHarness;

  beforeAll(async () => {
    harness = await startUatHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  // ── Primary run: 12 seeds, never-use-veto (this shard's slice) ─────────────

  it(
    `plays ${SEEDS.length} seeds to completion (never-use-veto) — no anomalies detected — ${SHARD_LABEL}`,
    { timeout: 120_000 },
    async () => {
      const seeds = SEEDS;
      // Uses direct callTool (no HTTP) for reliability: the transport layer added
      // non-deterministic overhead that caused stale-loop failures in CI for some seeds.
      const runs: RunResult[] = [];
      for (const s of seeds) runs.push(await runFullGameDirect(harness.directResolver, s, "never-use-veto"));
      const allAnomalies = runs.flatMap((r) => r.anomalies);

      // All games must finish. Include anomalies in the failure message so CI logs show the root cause.
      const unfinished = runs.filter((r) => !r.finished);
      if (unfinished.length > 0) {
        const detail = unfinished
          .map((r) => {
            const ants = r.anomalies.map((a) => `    [${a.kind}] w${a.week} ${a.beat}: ${a.detail}`).join("\n");
            return `  seed ${r.seed}: ${ants || "(no anomalies recorded)"}`;
          })
          .join("\n");
        expect.fail(`\nGames that did not finish (never-use-veto):\n${detail}\n`);
      }

      const noWinner = runs.filter((r) => r.finished && !r.winner).map((r) => `seed ${r.seed}`);
      expect(noWinner, "finished games without a winner").toEqual([]);

      // No anomalies.
      if (allAnomalies.length > 0) {
        const report = allAnomalies
          .map((a) => `  [${a.kind}] seed=${a.seed} week=${a.week} beat=${a.beat}: ${a.detail}`)
          .join("\n");
        expect.fail(`\nAnomalies detected (never-use-veto):\n${report}\n`);
      }

      // All games must have played at least 1 week.
      expect(runs.every((r) => r.weeksPlayed >= 1), "each game played ≥ 1 week").toBe(true);

      // At least some games must have produced player decisions (asserted independently over this
      // shard's non-empty slice — a clean shard partition never yields an empty slice here).
      const decisionsTotal = runs.reduce((n, r) => n + Object.values(r.decisionCounts).reduce((a, b) => a + b, 0), 0);
      expect(decisionsTotal, "total player decisions across this shard's runs").toBeGreaterThan(0);
    },
  );
});
