import { describe, it, expect } from "vitest";
import { SEASON_MEMORY, reputationApplies, softenedFeelings, castsReturner, pickReturner, carriedClaims, seasonResult, hallEntry, type ArchivedHouseguest } from "../../src/engine/seasonMemory";

/** Theme B foundation (ORW-662): seasons that remember. Roles only. */
const archived = (npcId: string, season: number): ArchivedHouseguest => ({ season, npcId, characterRef: `c-${npcId}`, placement: 9, juror: true, endToward: { trust: -0.6, affinity: -0.4, threat: 0.8 }, claims: [] });

describe("Theme B foundation: the player's choice, and a real returner", () => {
  it("only a return brings reputation and returners; starting new is clean", () => {
    expect(reputationApplies("return")).toBe(true);
    expect(reputationApplies("new")).toBe(false);
    expect(castsReturner("new", 5, 0)).toBe(false);
    expect(castsReturner("return", 0, 0)).toBe(false);
    expect(castsReturner("return", 5, SEASON_MEMORY.returnerChance - 0.01)).toBe(true);
    expect(castsReturner("return", 5, SEASON_MEMORY.returnerChance + 0.01)).toBe(false);
  });
  it("a returner comes from any season the player played, never one already cast", () => {
    const pool = [archived("npc:a", 1), archived("npc:b", 3)];
    expect(pickReturner(pool, new Set(["npc:a"]), 0)?.npcId).toBe("npc:b");
    expect(pickReturner(pool, new Set(), 0.99)?.season).toBe(3);
    expect(pickReturner(pool, new Set(["npc:a", "npc:b"]), 0.5)).toBeUndefined();
  });
  it("feelings soften with time but a grudge never vanishes", () => {
    const end = { trust: -0.6, affinity: -0.4, threat: 0.8 };
    expect(softenedFeelings(end, 0)).toEqual(end);
    const one = softenedFeelings(end, 1);
    expect(Math.abs(one.trust)).toBeLessThan(0.6);
    const many = softenedFeelings(end, 50);
    expect(many.trust).toBeCloseTo(end.trust * SEASON_MEMORY.keepAtLeast, 6);
  });
  it("the returner carries their own account, witnessed first, capped", () => {
    const claims = Array.from({ length: 10 }, (_, i) => ({ kind: "broke-deal", week: i, witnessed: i % 2 === 0 }));
    const kept = carriedClaims(claims);
    expect(kept).toHaveLength(SEASON_MEMORY.maxCarriedClaims);
    expect(kept.slice(0, 5).every((c) => c.witnessed)).toBe(true);
  });
});

describe("Theme B foundation: the hall of fame", () => {
  it("a finished season is kept with its result", () => {
    expect(seasonResult(1, true)).toBe("won");
    expect(seasonResult(2, true)).toBe("runner-up");
    expect(seasonResult(5, true)).toBe("jury");
    expect(seasonResult(14, false)).toBe("evicted-pre-jury");
    expect(hallEntry(2, 1, true, { bestMoveEventId: "e1" })).toEqual({ season: 2, placement: 1, result: "won", bestMoveEventId: "e1" });
  });
});
