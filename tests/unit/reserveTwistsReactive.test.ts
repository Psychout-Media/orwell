import { describe, it, expect } from "vitest";
import {
  planReserveTwists,
  triggeredTwist,
  TWIST_MIN_ACTIVE,
  type TwistPlan,
  type TwistSignals,
} from "../../src/engine/reserveTwists";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";

// Feature 0025 (reactive redesign) — the pure trigger model: dynamic per-season thresholds, a
// hold-back arm, each twist at most once, one twist per evaluation (the cooldown).

const armedPlan = (over: Partial<TwistPlan> = {}): TwistPlan => ({
  doubleEvictionAtActive: 8, doubleEvictionArmed: true,
  secretVetoStreak: 2, secretVetoArmed: true,
  battleBackAtJury: 1, battleBackArmed: true,
  ...over,
});
const sig = (over: Partial<TwistSignals> = {}): TwistSignals => ({
  activeCount: 12, juryCount: 0, lopsidedStreak: 0, ...over,
});

describe("0025 reactive triggers — the sealed per-season plan", () => {
  it("is deterministic under a seed and varies across seeds", () => {
    expect(planReserveTwists(new SeededRandom(1))).toEqual(planReserveTwists(new SeededRandom(1)));
    // Across a spread of seeds the thresholds genuinely differ (dynamic season to season).
    const targets = new Set(
      Array.from({ length: 30 }, (_, i) => planReserveTwists(new SeededRandom(i + 1)).doubleEvictionAtActive),
    );
    expect(targets.size).toBeGreaterThan(1);
  });

  it("holds back some seasons and arms others (reproducibly)", () => {
    const armed = Array.from({ length: 40 }, (_, i) => planReserveTwists(new SeededRandom(i + 1)).secretVetoArmed);
    expect(armed.some((a) => a)).toBe(true);       // some seasons fire
    expect(armed.some((a) => !a)).toBe(true);      // some are held back
  });

  it("all three fields stay within their seeded bands", () => {
    for (let i = 1; i <= 50; i++) {
      const p = planReserveTwists(new SeededRandom(i));
      expect(p.doubleEvictionAtActive).toBeGreaterThanOrEqual(6);
      expect(p.doubleEvictionAtActive).toBeLessThanOrEqual(9);
      expect(p.secretVetoStreak).toBeGreaterThanOrEqual(2);
      expect(p.secretVetoStreak).toBeLessThanOrEqual(3);
      expect(p.battleBackAtJury).toBeGreaterThanOrEqual(1);
      expect(p.battleBackAtJury).toBeLessThanOrEqual(3);
    }
  });
});

describe("0025 reactive triggers — triggeredTwist", () => {
  it("fires the double eviction when the house reaches the seeded size", () => {
    const p = armedPlan({ battleBackArmed: false, secretVetoArmed: false });
    expect(triggeredTwist(p, sig({ activeCount: 9 }), [])).toBeNull();     // not yet
    expect(triggeredTwist(p, sig({ activeCount: 8 }), [])).toBe("double-eviction");
    expect(triggeredTwist(p, sig({ activeCount: 7 }), [])).toBe("double-eviction"); // <= target
  });

  it("fires the secret veto once the house goes lopsided", () => {
    const p = armedPlan({ battleBackArmed: false, doubleEvictionArmed: false, secretVetoStreak: 3 });
    expect(triggeredTwist(p, sig({ lopsidedStreak: 2 }), [])).toBeNull();
    expect(triggeredTwist(p, sig({ lopsidedStreak: 3 }), [])).toBe("secret-veto");
  });

  it("fires the battle-back only inside the early-jury window", () => {
    const p = armedPlan({ doubleEvictionArmed: false, secretVetoArmed: false, battleBackAtJury: 2 });
    expect(triggeredTwist(p, sig({ juryCount: 1 }), [])).toBeNull();
    expect(triggeredTwist(p, sig({ juryCount: 2 }), [])).toBe("battle-back");
    expect(triggeredTwist(p, sig({ juryCount: 4 }), [])).toBeNull(); // window closed
  });

  it("never re-fires a twist that already fired (at most once each)", () => {
    const p = armedPlan();
    expect(triggeredTwist(p, sig({ activeCount: 8 }), ["double-eviction"])).not.toBe("double-eviction");
  });

  it("returns at most one twist per evaluation, by priority (the cooldown)", () => {
    // Battle-back and double-eviction both eligible: battle-back wins this roll, double defers.
    // ORW-1088: the battle-back field is jurors only, so it needs a second juror seated.
    const p = armedPlan({ battleBackAtJury: 1 });
    expect(triggeredTwist(p, sig({ activeCount: 8, juryCount: 1 }), [])).toBe("double-eviction");
    expect(triggeredTwist(p, sig({ activeCount: 8, juryCount: 2 }), [])).toBe("battle-back");
    // With battle-back already fired, the deferred double eviction fires next.
    expect(triggeredTwist(p, sig({ activeCount: 8, juryCount: 2 }), ["battle-back"])).toBe("double-eviction");
  });

  it("arms no new twist once too little game remains", () => {
    const p = armedPlan();
    expect(triggeredTwist(p, sig({ activeCount: TWIST_MIN_ACTIVE - 1, lopsidedStreak: 5, juryCount: 1 }), [])).toBeNull();
  });
});
