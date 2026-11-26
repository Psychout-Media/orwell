import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SEEDS, playSeeds, assertGradient } from "./calibrationGradientShared";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/**
 * 0101/#1401 Phase-2 (#1455) — the calibration GRADIENT gate, run with the OUTCOME-AFFECTING SHOWRUNNER
 * REWEIGHT flag ON. The gradient asserts the MONOTONIC social-play band over {@link SEEDS} seeds played as
 * a passive+active pair each: active jury-reach ≥ passive AND active wins ≥ passive across the set (a
 * player who shows up does at least as well). This is the "earned-wins inversion" guard the acceptance bar
 * names — if the reweight bent the closed-set spine so that showing up stopped paying, THIS band breaks and
 * ship BLOCKS. It is surfaced here, never papered over.
 *
 * The reweight is flipped process-globally for the whole run and reset in `afterAll`. Methodology + the
 * band are IMPORTED UNCHANGED from `calibrationGradientShared` — only the flag differs from the OFF gate,
 * so any gradient divergence is a real, attributable reweight effect. Roles only — no houseguest names.
 *
 * (Measured 2026-07-12: the thread scheduler's folds move only the OPEN-SET `player→NPC` reads, which the
 * synthetic passive/active drivers do not act on, so this ON run reproduces the OFF gradient; the gate is
 * the permanent GUARD that a future reweight change can never invert the "playing the game pays" property.)
 */

describe("0101/#1401 Phase-2 — calibration gradient holds with the showrunner reweight ON", () => {
  beforeAll(() => GameSessionAdapter.setShowrunnerReweightEnabled(true));
  afterAll(() => GameSessionAdapter.setShowrunnerReweightEnabled(null));

  it("the reweight is genuinely live for this run (structural non-vacuousness)", () => {
    expect(new GameSessionAdapter().showrunnerReweightEnabledNow(), "the reweight override is live for this run").toBe(true);
  });

  it(
    `across ${SEEDS} passive+active seed pairs WITH the reweight ON, the monotonic gradient band still holds`,
    { timeout: 600_000 },
    async () => {
      const results = await playSeeds(1, SEEDS + 1);
      const passiveReach = results.filter((r) => r.passive.status !== "evicted").length;
      const activeReach = results.filter((r) => r.active.status !== "evicted").length;
      const passiveWins = results.filter((r) => r.passive.won).length;
      const activeWins = results.filter((r) => r.active.won).length;
      // eslint-disable-next-line no-console
      console.log(`[reweight-ON] gradient: reach passive=${passiveReach}/${SEEDS} active=${activeReach}/${SEEDS}; wins passive=${passiveWins} active=${activeWins}`);
      assertGradient(results, expect as never);
    },
  );
});
