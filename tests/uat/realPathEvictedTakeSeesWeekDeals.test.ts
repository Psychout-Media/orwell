import { describe, it, expect, vi } from "vitest";
import { playSeason } from "../support/whatFired/player";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { DealLedger } from "../../src/engine/deals";
import { firstSeedWhere } from "../support/firstSeedWhere";

/**
 * ORW-871 (bug scan B1-7): a houseguest's week-scoped promises used to be closed (as "kept") one line BEFORE what the evicted held was taken with them (0195), so the evicted take found nothing open and nobody reacted to
 * losing a shield. REAL PATH: a season is played through the player channel (nothing hand-set). The two engine steps are observed with call-through spies (same arguments, same result): at EVERY eviction the evicted take
 * must run BEFORE the week's deals are closed. ORW-1096 (Coordinator ruling 2026-11-27): the lapse of an evictee's open deal is pinned by the unit test `tests/unit/evictedTake.test.ts` ("an NPC evictee's deals lapse"). This
 * real-path test no longer claims the take meets the PLAYER's open deal: votes are cast before the eviction is revealed, so the player's own vote settles their safety deal (kept, or broken) before the take, on every seed.
 * HEAVY LANE (tests/uat/**). Roles only.
 */
describe("ORW-871 REAL PATH: the evicted take runs before the week's deals are closed", () => {
  it("at every eviction of a played season the evicted take runs before the week's deals expire", async () => {
    let order: string[] = [];
    const expireOrig = DealLedger.prototype.expireWeekScoped; const takeOrig = GameSessionAdapter.prototype.evictedTakeWithThem;
    const take = vi.spyOn(GameSessionAdapter.prototype, "evictedTakeWithThem").mockImplementation(function (this: GameSessionAdapter) { order.push("take"); return takeOrig.call(this); });
    const expire = vi.spyOn(DealLedger.prototype, "expireWeekScoped").mockImplementation(function (this: DealLedger, week: number) { order.push("expire"); return expireOrig.call(this, week); });
    let seen: string[];
    try {
      seen = (await firstSeedWhere(async (seed, sandbox) => {
        order = [];
        await playSeason({ user: sandbox, seed, maxMessages: 900 });
        return order.filter((o) => o === "take").length >= 3 ? [...order] : undefined; // positive control: the season held several evictions
      }, { from: 1, to: 8, hint: [5], sandbox: (s) => `wf-${s}`, what: "a played season with at least three evicted takes" })).at;
    } finally { take.mockRestore(); expire.mockRestore(); }
    expect(seen.filter((o) => o === "take").length, "evictions were played").toBeGreaterThanOrEqual(3);
    for (let i = 0; i < seen.length; i++) if (seen[i] === "expire") expect(seen[i - 1], `step ${i}: the evicted take runs first`).toBe("take");
  }, 1_800_000);
});
