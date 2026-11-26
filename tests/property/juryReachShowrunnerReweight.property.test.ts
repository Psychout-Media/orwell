import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SEEDS, playSeeds, assertBand } from "./juryReachShared";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/**
 * 0101/#1401 Phase-2 (#1455) — the jury-reach calibration gate, run with the OUTCOME-AFFECTING SHOWRUNNER
 * REWEIGHT flag ON. The sibling living-house layers (0087 trajectories / 0092 secret pacing) prove
 * neutrality-when-OFF by byte-identity; the reweight is different — it re-orders which simmering thread
 * wins the scheduler's scarce per-tick slot, so it CANNOT be pinned outcome-neutral by construction. Its
 * acceptance bar is instead a DISTRIBUTION one: the exact same passive {@link SEEDS}-season jury-reach band
 * (`assertBand` — FLOOR/CEILING reach + the F2_WIN_MAX ceiling + the EARNED_WINS teeth) must still hold with
 * the reweight ON. A band break BLOCKS ship (it would mean the producer notes bent the closed-set fairness
 * spine) — it is surfaced here, never papered over.
 *
 * The reweight is flipped process-globally for the whole run (the same mechanism the God-Mode dial +
 * `secretPacing` use), so every season `playSeeds` composes plays under it, then reset in `afterAll` so it
 * never leaks to another file. Methodology + the band are IMPORTED UNCHANGED from `juryReachShared` — only
 * the flag differs from the OFF gate, so any divergence is a real, attributable reweight effect. Roles
 * only — no houseguest names.
 *
 * (Measured 2026-07-12: because the thread scheduler's folds move only the player's OWN `player→NPC` reads
 * — the OPEN set — and a PASSIVE driver never acts on those, this ON run reproduces the OFF band; the gate
 * is the permanent GUARD that a future change to the reweight can never bend the deterministic jury-reach
 * fairness spine. The reweight's real re-pacing lands on a live player, whom this driver cannot model.)
 */

describe("0101/#1401 Phase-2 — jury-reach band holds with the showrunner reweight ON", () => {
  beforeAll(() => GameSessionAdapter.setShowrunnerReweightEnabled(true));
  afterAll(() => GameSessionAdapter.setShowrunnerReweightEnabled(null));

  it("the reweight is genuinely live for this run (structural non-vacuousness)", () => {
    // A fresh adapter resolves the process-global override ON — the flag the seasons below actually play under.
    expect(new GameSessionAdapter().showrunnerReweightEnabledNow(), "the reweight override is live for this run").toBe(true);
  });

  it(
    `across ${SEEDS} passive seeded live seasons WITH the reweight ON, the jury-reach band still holds`,
    { timeout: 600_000 },
    async () => {
      const results = await playSeeds(1, SEEDS + 1);
      // Report the distribution (the acceptance evidence) before the assertion, so a CI log shows ON numbers.
      const reachedJury = results.filter((r) => r.status !== "evicted").length;
      const f2Wins = results.filter((r) => r.f2Win).length;
      // eslint-disable-next-line no-console
      console.log(`[reweight-ON] jury-reach: reached=${reachedJury}/${SEEDS}, F2 wins=${f2Wins}, seats=${results.map((r) => r.status).join(",")}`);
      assertBand(results, expect as never);
    },
  );
});
