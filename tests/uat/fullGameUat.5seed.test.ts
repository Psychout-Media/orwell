/**
 * tests/uat/fullGameUat.5seed.test.ts
 *
 * Heavy-sims lane: uat-5seed.
 *
 * The veto-use path — 5 seeds, always-use-veto, via the direct callTool path. Exercises
 * veto-save, the replacement decision, and the final-4 veto-revert (no legal replacement →
 * the engine reverts; the replacement pend is absent). One of the three slices the former
 * single fullGameUat.test.ts was split into so its independent `it` blocks fan out across
 * separate CI runners; seeds and assertions are unchanged.
 *
 * See tests/uat/fullGameUatHarness.ts for the shared driver + invariant checkers.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startUatHarness,
  runFullGameDirect,
  type UatHarness,
  type RunResult,
} from "./fullGameUatHarness";

describe("full-game UAT — 5 seeds (always-use-veto)", () => {
  let harness: UatHarness;

  beforeAll(async () => {
    harness = await startUatHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  // ── Veto-use path: 5 seeds, always-use-veto ───────────────────────────────

  it(
    "plays 5 seeds with always-use-veto — covers veto-save, replacement, and final-4 revert",
    { timeout: 60_000 },
    async () => {
      const seeds = [1, 2, 3, 4, 5];
      const runs: RunResult[] = [];
      for (const s of seeds) runs.push(await runFullGameDirect(harness.directResolver, s, "always-use-veto"));
      const allAnomalies = runs.flatMap((r) => r.anomalies);

      const unfinished = runs.filter((r) => !r.finished);
      if (unfinished.length > 0) {
        const detail = unfinished
          .map((r) => {
            const ants = r.anomalies.map((a) => `    [${a.kind}] w${a.week} ${a.beat}: ${a.detail}`).join("\n");
            return `  seed ${r.seed}: ${ants || "(no anomalies recorded)"}`;
          })
          .join("\n");
        expect.fail(`\nGames that did not finish (always-use-veto):\n${detail}\n`);
      }

      const noWinner = runs.filter((r) => r.finished && !r.winner).map((r) => `seed ${r.seed}`);
      expect(noWinner, "finished games without a winner (always-use-veto)").toEqual([]);

      if (allAnomalies.length > 0) {
        const report = allAnomalies
          .map((a) => `  [${a.kind}] seed=${a.seed} week=${a.week} beat=${a.beat}: ${a.detail}`)
          .join("\n");
        expect.fail(`\nAnomalies detected (always-use-veto):\n${report}\n`);
      }
    },
  );
});
