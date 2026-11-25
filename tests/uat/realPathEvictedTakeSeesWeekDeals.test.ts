import { describe, it, expect, vi } from "vitest";
import { playSeason } from "../support/whatFired/player";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { DealLedger } from "../../src/engine/deals";
import { horizonOf } from "../../src/domain/deal";

/**
 * ORW-871 (bug scan B1-7): a houseguest's week-scoped promises used to be closed (as "kept") one line BEFORE what the evicted held was taken with them (0195), so the evicted take found nothing open and nobody reacted to
 * losing a shield. REAL PATH: seasons are played through the player channel (nothing hand-set). The two engine steps are observed with call-through spies (same arguments, same result) at every eviction: the evicted take
 * must run BEFORE the week's deals are closed, and across the seeds the evicted take must have met at least one open week-scoped deal of the evictee (so the order mattered and the test is not vacuous). HEAVY LANE (tests/uat/**).
 */
describe("ORW-871 REAL PATH: the evicted take sees the week's deals before they are closed", () => {
  it("at every eviction the evicted take runs before the week's deals expire, and it met open week-scoped deals of the evictee", async () => {
    const order: string[] = []; const met: number[] = []; const errs: string[] = [];
    const takeOrig = GameSessionAdapter.prototype.evictedTakeWithThem; const expireOrig = DealLedger.prototype.expireWeekScoped;
    const take = vi.spyOn(GameSessionAdapter.prototype, "evictedTakeWithThem").mockImplementation(function (this: GameSessionAdapter) {
      order.push("take");
      try {
        const live = (this as unknown as { live: { evictionOrder: string[] } }).live;
        const evictee = live.evictionOrder[live.evictionOrder.length - 1]!;
        const deals = (this as unknown as { deals: { all: Array<{ status: string; kind: string; parties: string[] }> } }).deals.all;
        met.push(deals.filter((d) => d.status === "open" && horizonOf(d.kind as never) === "week" && d.parties.includes(evictee)).length);
      } catch (e) { errs.push(String(e).slice(0, 120)); }
      return takeOrig.call(this);
    });
    const expire = vi.spyOn(DealLedger.prototype, "expireWeekScoped").mockImplementation(function (this: DealLedger, week: number) { order.push("expire"); return expireOrig.call(this, week); });
    try {
      for (const seed of (process.env.ORW871_SEEDS ?? "6,7").split(",").map(Number)) await playSeason({ user: `wf-${seed}`, seed, maxMessages: 900 });
    } finally { take.mockRestore(); expire.mockRestore(); }
    expect(order.length, "evictions were played").toBeGreaterThan(0);
    for (let i = 0; i < order.length; i++) if (order[i] === "expire") expect(order[i - 1], `step ${i}: the evicted take runs first`).toBe("take");
    expect(met.some((n) => n > 0), "at least one eviction found an open week-scoped deal of the evictee").toBe(true);
  }, 1_800_000);
});
