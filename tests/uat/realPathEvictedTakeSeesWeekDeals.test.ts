import { describe, it, expect, vi } from "vitest";
import { playSeason } from "../support/whatFired/player";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { DealLedger } from "../../src/engine/deals";
import { horizonOf } from "../../src/domain/deal";
import { firstSeedWhere } from "../support/firstSeedWhere";

/**
 * ORW-871 (bug scan B1-7): a houseguest's week-scoped promises used to be closed (as "kept") one line BEFORE what the evicted held was taken with them (0195), so the evicted take found nothing open and nobody reacted to
 * losing a shield. REAL PATH: a season is played through the player channel (nothing hand-set). The two engine steps are observed with call-through spies (same arguments, same result) at every eviction: the evicted
 * take must run BEFORE the week's deals are closed (at EVERY eviction), and the take must meet an open week-scoped deal of the evictee and lapse it (so the order mattered and the test is not vacuous).
 * The open deal is made by the PLAYER through the real lever, not hoped for from the house (the house mints fewer of its own as its pacing changes: ORW-702, ORW-905): once a week's nominations are set, the player
 * asks the nominees, in turn, for a safety deal (a week-scoped kind; each nominee's own consent decides) until ONE agrees, and then votes to evict the OTHER nominee, so the player never breaks it. The first
 * season in which the house evicts that partner anyway is the precondition (scanned in a fixed order). HEAVY LANE (tests/uat/**). Roles only.
 */
type Deal = { id: string; kind: string; status: string; parties: string[] };
describe("ORW-871 REAL PATH: the evicted take sees the week's deals before they are closed", () => {
  it("at every eviction the evicted take runs before the week's deals expire; the take meets the player's open week deal with the evictee and lapses it", async () => {
    let order: string[] = [], met: number[] = [], openAtTake: string[][] = [];
    const takeOrig = GameSessionAdapter.prototype.evictedTakeWithThem; const expireOrig = DealLedger.prototype.expireWeekScoped;
    const take = vi.spyOn(GameSessionAdapter.prototype, "evictedTakeWithThem").mockImplementation(function (this: GameSessionAdapter) {
      order.push("take");
      const live = (this as unknown as { live: { evictionOrder: string[] } }).live;
      const evictee = live.evictionOrder[live.evictionOrder.length - 1]!;
      const deals = (this as unknown as { deals: { all: Deal[] } }).deals.all;
      const open = deals.filter((d) => d.status === "open" && horizonOf(d.kind as never) === "week" && d.parties.includes(evictee));
      met.push(open.length); openAtTake.push(open.map((d) => d.id));
      return takeOrig.call(this);
    });
    const expire = vi.spyOn(DealLedger.prototype, "expireWeekScoped").mockImplementation(function (this: DealLedger, week: number) { order.push("expire"); return expireOrig.call(this, week); });
    let found: { order: string[]; met: number[]; partnerDeal: Deal };
    try {
      found = (await firstSeedWhere(async (seed, sandbox) => {
        order = []; met = []; openAtTake = [];
        const deal = new Map<number, { id: string; partner: string; other: string }>(); // per week: the player's one deal, and who to vote out
        let evictedPartner: { id: string; partner: string } | undefined; let lastSess: any; // eslint-disable-line @typescript-eslint/no-explicit-any
        await playSeason({ user: sandbox, seed, maxMessages: 900,
          decide: (p, sess) => {
            const w = deal.get((sess.live?.week as number) ?? 0);
            if (p.kind !== "eviction-vote" || !w || !w.id) return undefined;
            return p.options.some((o: { id: string }) => o.id === w.other) ? { kind: "eviction-vote", vote: w.other } : undefined; // the player keeps their word
          },
          watch: async ({ sess, call }) => {
            lastSess = sess;
            const live = sess.live as { week: number; nominees?: string[]; evictionOrder: string[] } | undefined;
            if (!live) return false;
            const noms = (live.nominees ?? []).filter((n) => n !== "player");
            if (noms.length === 2 && !deal.has(live.week)) {
              deal.set(live.week, { id: "", partner: "", other: "" }); // asked once per week
              for (const n of noms) {
                const r = (await call("makeDeal", { with: n, kind: "safety", terms: "we keep each other safe this week" })) as { id?: string } | null;
                if (r?.id) { deal.set(live.week, { id: r.id, partner: n, other: noms.find((x) => x !== n)! }); break; }
              }
            }
            const out = live.evictionOrder[live.evictionOrder.length - 1];
            if (out && !evictedPartner) for (const d of deal.values()) if (d.id && d.partner === out) evictedPartner = { id: d.id, partner: out };
            return !!evictedPartner && openAtTake.some((ids) => ids.includes(evictedPartner!.id)); // stop once the partner's eviction has been taken with the PLAYER's deal open (a house deal of the evictee's does not count: the claim below is about the player's deal)
          } });
        if (!evictedPartner || !openAtTake.some((ids) => ids.includes(evictedPartner!.id))) return undefined;
        const partnerDeal = (lastSess.deals.all as Deal[]).find((d) => d.id === evictedPartner!.id)!;
        return { order: [...order], met: [...met], partnerDeal };
      }, { from: 1, to: 16, hint: [6], sandbox: (s) => `wf-${s}`, what: "the house evicting a nominee who holds the player's open safety deal" })).at;
    } finally { take.mockRestore(); expire.mockRestore(); }
    ({ order, met } = found);
    expect(order.length, "evictions were played").toBeGreaterThan(0);
    for (let i = 0; i < order.length; i++) if (order[i] === "expire") expect(order[i - 1], `step ${i}: the evicted take runs first`).toBe("take");
    expect(met.some((n) => n > 0), "an eviction found an open week-scoped deal of the evictee").toBe(true);
    expect(found.partnerDeal.status, "the evicted take lapsed the player's open deal with them (it was never kept)").toBe("lapsed");
  }, 1_800_000);
});
