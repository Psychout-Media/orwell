import { describe, it, expect } from "vitest";
import { FIRST_RETURN, firstReturnOf, firstReturnImpact } from "../../src/engine/firstImpressionReturn";
import { playedGame } from "../support/playedGame";
import { PLAYER, type EntityId } from "../../src/domain/ids";

/** ORW-1080 (Ryne 2026-11-26): a houseguest's day-one read of the player comes back later, in what they say and decide. Roles only. */
const base = { trust: 0.5, affinity: 0.5 };

describe("how a first impression comes back", () => {
  it("only a view they really took; it either held or was wrong, and settles them into how they see the player now", () => {
    expect(firstReturnOf({ trustLean: 0.05, affinityLean: 0.05 }, base, base)).toBeNull();
    const held = firstReturnOf({ trustLean: -0.3, affinityLean: -0.3 }, { trust: 0.2, affinity: 0.2 }, base)!;
    expect(held).toEqual({ took: "wary", held: true });
    expect(firstReturnImpact(held).trust).toBeLessThan(0);
    const wrong = firstReturnOf({ trustLean: -0.3, affinityLean: -0.3 }, { trust: 0.8, affinity: 0.8 }, base)!;
    expect(wrong).toEqual({ took: "wary", held: false });
    expect(firstReturnImpact(wrong).trust).toBeGreaterThan(0);
  });
});

describe("in a played game", () => {
  it("it comes back after the early days, at most once a houseguest, reaches what they say, and the view carries no clause and no number", () => {
    let seen = 0;
    for (const seed of [1, 2, 3]) {
      const g = playedGame({ seed });
      const x = g.s as unknown as { live: { dayNumber?: number; firstReturns?: Record<string, { day: number }> }; npcVoice(id: EntityId): { dayOneBack?: unknown } | null };
      let voiced = false;
      try {
        g.playUntil(() => {
          for (const [id, r] of Object.entries(x.live?.firstReturns ?? {})) {
            expect(r.day).toBeGreaterThanOrEqual(FIRST_RETURN.fromDay);
            const v = x.npcVoice(id as EntityId);
            if (v?.dayOneBack) { voiced = true; expect(Object.keys(v.dayOneBack as object).sort()).toEqual(["firstTook", "held"]); }
          }
          return voiced && (x.live.dayNumber ?? 0) > 30;
        }, 6000, "a first impression coming back");
      } catch (e) { if (!String(e).includes("season ended")) throw e; }
      const all = Object.keys(x.live.firstReturns ?? {});
      expect(new Set(all).size).toBe(all.length);
      expect(all).not.toContain(PLAYER);
      if (voiced) seen++;
    }
    expect(seen).toBeGreaterThan(0);
  }, 600_000);
});
