import { describe, it, expect } from "vitest";
import { resolveCompetition, CompetitionIntents, type Competitor } from "../../src/domain/competitionOutcome";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";

/**
 * The hidden sleep→comp penalty (ADR 0006 §Principle 4). Roles only: a RESTED and a TIRED
 * houseguest, a FAVORITE and an UNDERDOG. Asserts the term is real, symmetric, never protective,
 * and BYTE-IDENTICAL when absent (so the seeded calibration spine is unmoved).
 */
const RESTED = "rested-hg";
const TIRED = "tired-hg";
const N = 400;

const EVEN = { physical: 0.6, mental: 0.6, social: 0.6 };

/** Win rate of the first competitor over the second across N seeds, given each one's rest deficit. */
function firstWinRate(first: Competitor, second: Competitor): number {
  let firstWins = 0;
  for (let seed = 0; seed < N; seed++) {
    const r = resolveCompetition([first, second], "physical", new CompetitionIntents(), new SeededRandom(seed));
    if (r.winner === first.id) firstWins++;
  }
  return firstWins / N;
}

describe("sleep is a real, bounded competition cost (ADR 0006)", () => {
  it("between equally-skilled houseguests, the rested one wins a clear majority", () => {
    const rate = firstWinRate(
      { id: RESTED, stats: EVEN, restPenalty: 0 },
      { id: TIRED, stats: EVEN, restPenalty: 1 },
    );
    expect(rate).toBeGreaterThan(0.55); // a meaningful tilt, not a coin flip
    // deliberate re-pin (ORW-322, Ryne 2026-11-12: staying up must cost MORE): a FULL all-nighter (d = 1) now costs the capped 0.6, so the rested one wins ~97% - a very likely loss, never a guaranteed one.
    expect(rate).toBeLessThan(0.995);
  });

  it("is never protective — a TIRED favorite wins strictly less than the same favorite RESTED", () => {
    const favorite = (deficit: number): Competitor => ({ id: "favorite", stats: { physical: 0.85, mental: 0.85, social: 0.85 }, restPenalty: deficit });
    const underdog: Competitor = { id: "underdog", stats: { physical: 0.5, mental: 0.5, social: 0.5 } };
    const restedFav = firstWinRate(favorite(0), underdog);
    const tiredFav = firstWinRate(favorite(1), underdog);
    expect(tiredFav).toBeLessThan(restedFav);  // staying up costs the favorite real wins
    // deliberate re-pin (ORW-322): a full all-nighter (cap 0.6) outweighs this 0.35 stat edge, so the tired favorite is now the underdog - but the cap keeps it bounded: still some wins.
    expect(tiredFav).toBeGreaterThan(0.05);
    // ...while a LATE bed (d = 0.25, 2am) still leaves the favorite a favorite.
    expect(firstWinRate(favorite(0.25), underdog)).toBeGreaterThan(0.5);
  });

  it("is symmetric — applied by the same math regardless of field position (no player special-case)", () => {
    // Same matchup, tired houseguest in either slot: the rested one wins a majority either way.
    const tiredSecond = firstWinRate({ id: RESTED, stats: EVEN, restPenalty: 0 }, { id: TIRED, stats: EVEN, restPenalty: 1 });
    const restedSecond = 1 - firstWinRate({ id: TIRED, stats: EVEN, restPenalty: 1 }, { id: RESTED, stats: EVEN, restPenalty: 0 });
    expect(tiredSecond).toBeGreaterThan(0.55);
    expect(restedSecond).toBeGreaterThan(0.55);
  });

  it("is byte-identical when absent — an omitted restPenalty matches an explicit 0 for every seed", () => {
    for (let seed = 0; seed < N; seed++) {
      const omitted = resolveCompetition(
        [{ id: "a", stats: EVEN }, { id: "b", stats: { physical: 0.7, mental: 0.5, social: 0.6 } }],
        "physical", new CompetitionIntents(), new SeededRandom(seed),
      );
      const explicitZero = resolveCompetition(
        [{ id: "a", stats: EVEN, restPenalty: 0 }, { id: "b", stats: { physical: 0.7, mental: 0.5, social: 0.6 }, restPenalty: 0 }],
        "physical", new CompetitionIntents(), new SeededRandom(seed),
      );
      expect(omitted.winner).toBe(explicitZero.winner);
      expect(omitted.scores).toEqual(explicitZero.scores);
    }
  });

  it("refuses a non-finite rest deficit (anti-sycophancy: malformed input is a refusal, not a silent fix)", () => {
    expect(() =>
      resolveCompetition([{ id: "a", stats: EVEN, restPenalty: NaN }], "physical", new CompetitionIntents(), new SeededRandom(1)),
    ).toThrow(/restPenalty/);
  });
});
