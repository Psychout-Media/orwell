import { describe, it, expect, vi } from "vitest";
import { playSeason } from "../support/whatFired/player";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { DealLedger } from "../../src/engine/deals";
import { horizonOf } from "../../src/domain/deal";
import { firstSeedWhere } from "../support/firstSeedWhere";

/**
 * ORW-871 (bug scan B1-7): a houseguest's week-scoped promises used to be closed (as "kept") one line BEFORE what the evicted held was taken with them (0195), so the evicted take found nothing open and nobody reacted to
 * losing a shield. REAL PATH: seasons are played through the player channel (nothing hand-set). The two engine steps are observed with call-through spies (same arguments, same result) at every eviction: the evicted take
 * must run BEFORE the week's deals are closed, and across the seeds the evicted take must have met at least one open week-scoped deal of the evictee (so the order mattered and the test is not vacuous). HEAVY LANE (tests/uat/**).
 */
describe("ORW-871 REAL PATH: the evicted take sees the week's deals before they are closed", () => {
  it("at every eviction the evicted take runs before the week's deals expire, and it met open week-scoped deals of the evictee", async () => {
    let order: string[] = [], met: number[] = [], dealt: string[] = []; const errs: string[] = [];
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
      // the precondition (ORW-702: the house decides which evictions carry an open week deal): the first season from 6 in which some eviction met an open week-scoped deal of the
      // evictee, so the order is tested where it matters; the order claim is then checked at every eviction of that season
      // ORW-702: the house mints fewer week-scoped deals of its own now, so the PLAYER makes them, through the real lever: once a week's nominations are set, the player asks
      // each nominee for a safety deal (a week-scoped kind; the nominee's own consent decides). The precondition is a season where a partner of such a deal is then evicted
      // while it is still open; the claims are the order at every eviction, that the evicted take met that deal, and that it lapsed it (not kept).
      ({ order, met, dealt } = (await firstSeedWhere(async (seed, sandbox) => {
        order = []; met = [];
        const asked = new Set<string>(); const mine: string[] = []; let evictedPartner: string | undefined; let lastSess: any; // eslint-disable-line @typescript-eslint/no-explicit-any
        await playSeason({ user: sandbox, seed, maxMessages: 900, watch: async ({ sess, call }) => {
          lastSess = sess;
          const live = sess.live as { week: number; nominees?: string[]; evictionOrder: string[] } | undefined;
          if (!live) return false;
          for (const n of live.nominees ?? []) {
            const key = `${live.week}:${n}`;
            if (n === "player" || asked.has(key)) continue;
            asked.add(key);
            const r = (await call("makeDeal", { with: n, kind: "safety", terms: "we keep each other safe this week" })) as { id?: string } | null;
            if (r?.id) mine.push(r.id);
          }
          const out = live.evictionOrder[live.evictionOrder.length - 1];
          if (out && !evictedPartner && (sess.deals.all as Array<{ id: string; parties: string[] }>).some((d) => mine.includes(d.id) && d.parties.includes(out))) evictedPartner = out;
          return false;
        } });
        if (!evictedPartner || !met.some((n) => n > 0)) return undefined;
        const lapsedMine = (lastSess.deals.all as Array<{ id: string; status: string; parties: string[] }>).filter((d) => mine.includes(d.id) && d.parties.includes(evictedPartner!));
        return { order: [...order], met: [...met], dealt: lapsedMine.map((d) => d.status) };
      }, { from: 1, to: 16, hint: [13], sandbox: (s) => `wf-${s}`, what: "an eviction of a houseguest who holds an open week-scoped deal with the player" })).at);
    } finally { take.mockRestore(); expire.mockRestore(); }
    expect(order.length, "evictions were played").toBeGreaterThan(0);
    for (let i = 0; i < order.length; i++) if (order[i] === "expire") expect(order[i - 1], `step ${i}: the evicted take runs first`).toBe("take");
    expect(met.some((n) => n > 0), "at least one eviction found an open week-scoped deal of the evictee").toBe(true);
    expect(dealt.length, "the player's deal with the evictee is on the ledger").toBeGreaterThan(0);
    for (const st of dealt) expect(st, "the evicted take lapsed the open deal (it was never kept)").toBe("lapsed");
  }, 1_800_000);
});
