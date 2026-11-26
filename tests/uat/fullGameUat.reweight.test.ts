import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startUatHarness, runFullGameDirect, type UatHarness } from "./fullGameUatHarness";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/**
 * 0101/#1401 Phase-2 (#1455) — the full-game UAT, run with the OUTCOME-AFFECTING SHOWRUNNER REWEIGHT flag
 * ON. The 12-seed / 5-seed UAT files assert the loop's structural invariants (every game FINISHES, no
 * Vault-stat leak in any player response, no illegal-id / ceremony / roster anomaly, ≥1 week played). The
 * reweight re-orders which simmering thread the off-screen tick surfaces — which perturbs the hidden layer
 * — so this file re-runs a modest seed slice WITH it on and proves the loop STILL completes cleanly under
 * it: the pacing bias must never wedge a game, leak the Vault, or break a ceremony.
 *
 * The reweight is flipped process-globally BEFORE the harness composes its runtime (so every session it
 * builds plays under it) and reset in `afterAll`. Roles only — no houseguest names.
 */

const SEEDS = [1, 2, 3, 4]; // a modest slice — the completion/leak invariants are per-seed, no aggregate

describe("0101/#1401 Phase-2 — the full game completes cleanly with the showrunner reweight ON", () => {
  let harness: UatHarness;

  beforeAll(async () => {
    GameSessionAdapter.setShowrunnerReweightEnabled(true); // ON before the runtime composes its sessions
    harness = await startUatHarness();
  });

  afterAll(async () => {
    await harness?.close();
    GameSessionAdapter.setShowrunnerReweightEnabled(null); // never leak the override to another file
  });

  it("the reweight is genuinely live for this run (structural non-vacuousness)", () => {
    expect(new GameSessionAdapter().showrunnerReweightEnabledNow(), "the reweight override is live for this run").toBe(true);
  });

  it(
    `plays ${SEEDS.length} full seeded games WITH the reweight ON — each finishes with no anomalies`,
    { timeout: 600_000 },
    async () => {
      for (const seed of SEEDS) {
        const run = await runFullGameDirect(harness.directResolver, seed, "never-use-veto");
        expect(run.finished, `seed ${seed}: the game must finish with the reweight on`).toBe(true);
        expect(run.weeksPlayed, `seed ${seed}: at least one week was played`).toBeGreaterThan(0);
        expect(run.anomalies, `seed ${seed}: anomalies with reweight ON: ${JSON.stringify(run.anomalies)}`).toEqual([]);
      }
    },
  );
});
