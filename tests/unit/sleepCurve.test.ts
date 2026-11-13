import { describe, it, expect } from "vitest";
import { sleepCost, resolveCompetition, CompetitionIntents } from "../../src/domain/competitionOutcome";
import { TEMPERATURE_CONSTANTS } from "../../src/domain/temperatureConstants";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";

/**
 * ORW-322 (Ryne 2026-11-12): staying up must cost more, the later the worse. The curve over the graded rest deficit d (0..1 = hours past midnight / 8) is convex and capped:
 * min(0.6, 0.8 * d^1.5). Roles only.
 */
const W = TEMPERATURE_CONSTANTS.outcome;
const H = (hoursPastMidnight: number) => sleepCost(hoursPastMidnight / 8, W);

describe("the sleep-debt curve", () => {
  it("is exactly 0 for a rested competitor (byte-identical scores), convex, and capped", () => {
    expect(sleepCost(0, W)).toBe(0);
    expect(sleepCost(-1, W)).toBe(0);
    expect(H(1)).toBeCloseTo(0.035, 3);
    expect(H(2)).toBeCloseTo(0.1, 3);
    expect(H(4)).toBeCloseTo(0.283, 3);
    expect(H(6)).toBeCloseTo(0.52, 2);
    expect(H(8)).toBe(0.6);                       // the cap: an all-nighter costs 0.6, not 0.8
    expect(sleepCost(7, W)).toBe(0.6);            // out-of-range deficits are bounded
    // convex: each extra hour costs MORE than the one before (the longer you push it, the harder it bites)
    const steps = [1, 2, 3, 4, 5].map((h) => H(h) - H(h - 1));
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeGreaterThan(steps[i - 1]!);
  });
  it("sleepPenalty = 0 still switches the whole consequence off", () => {
    expect(sleepCost(1, { ...W, sleepPenalty: 0 })).toBe(0);
  });
  it("the before/after duel table: equal-skill rested player vs a sleep-deprived one (rested win rate, 4000 seeds)", () => {
    const stat = { physical: 0.5, mental: 0.5, social: 0.5 };
    const restedWins = (d: number): number => {
      let wins = 0;
      for (let s = 1; s <= 4000; s++) {
        const r = resolveCompetition([{ id: "rested", stats: stat, restPenalty: 0 }, { id: "tired", stats: stat, restPenalty: d }], "physical", new CompetitionIntents(), new SeededRandom(s * 7919 + 2));
        if (r.winner === "rested") wins++;
      }
      return wins / 4000;
    };
    // before (linear 0.20*d): 1am 53%, 2am 57%, 4am 62%, 6am 68%, all-nighter 73%
    const after = { 1: restedWins(1 / 8), 2: restedWins(2 / 8), 4: restedWins(4 / 8), 6: restedWins(6 / 8), 8: restedWins(1) };
    expect(after[1]).toBeGreaterThan(0.52); expect(after[1]).toBeLessThan(0.6);   // a 1am chat stays cheap
    expect(after[2]).toBeGreaterThan(0.58); expect(after[2]).toBeLessThan(0.66);   // ~62%
    expect(after[4]).toBeGreaterThan(0.75); expect(after[4]).toBeLessThan(0.85);   // ~80%
    expect(after[6]).toBeGreaterThan(0.9);                                         // ~95%
    expect(after[8]).toBeGreaterThan(0.95); expect(after[8]).toBeLessThan(0.995);  // ~97%, never a guaranteed loss
    expect(after[1]).toBeLessThan(after[2]); expect(after[2]).toBeLessThan(after[4]); expect(after[4]).toBeLessThan(after[6]);
  });
});
