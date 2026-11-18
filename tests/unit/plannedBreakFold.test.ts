import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { Deal } from "../../src/domain/deal";
import { recordPlan, type PlanStore } from "../../src/engine/dealPlans";

/**
 * ORW-684 item 2: a planned break folds like every other betrayal. When a houseguest carries out a secret plan to break a deal, the break leaves
 * (1) the breaker's guilt (the existing 0181 fold), (2) a why-record (decisionWhy + statedReasons), and (3) once the wronged side LEARNS of it, the
 * same lied-to-me claim a break seen at once leaves. TEST-ONLY seams reach the live season, the deal ledger and the private carry-out. Roles only.
 */
type Seam = {
  live: { playedGame?: boolean; dealPlans?: PlanStore; week: number; beat: string; beliefs?: Record<string, Array<{ kind: string; subject: string; value: boolean }>>; decisionWhy?: Array<{ kind: string; by: string; options: Array<{ option: string }> }>; statedReasons?: Array<{ decision: string; decider: string; public: boolean }> };
  deals: { make(parties: [string, string], kind: string, terms: string, madeEventId?: string, madeWeek?: number): Deal; learnOfBreak(d: Deal, sink: object): boolean };
  planAndCarryOutDeals(): void;
  learnedBreakClaim(w: string, b: string, d: Deal): void;
  feelGuilt(b: string, w: string): void;
};

function setup(seed: number, partnerIsPlayer: boolean) {
  const sb = new GameSessionRegistry().sandboxFor(`planned-break-${seed}`);
  sb.session.setDealPlansEnabled(true);
  sb.session.createCharacter({ playerName: "The Player", seed });
  const s = sb.session as unknown as Seam;
  s.live.playedGame = true;
  const [npc, other] = sb.session.livingIds().filter((id) => id !== PLAYER);
  const partner = partnerIsPlayer ? PLAYER : other!;
  const deal = s.deals.make([npc!, partner], "safety", "a safety deal", undefined, s.live.week);
  recordPlan((s.live.dealPlans ??= {}), deal.id, npc!, { kind: "break-at", moment: { week: s.live.week, at: "nominations" } }, s.live.week);
  s.live.beat = "nominations";
  return { s, npc: npc!, partner, deal };
}

describe.each([[true], [false]])("a planned break (partner is the player: %s)", (partnerIsPlayer) => {
  it("is carried out and leaves the breaker's guilt and a why-record naming the partner", () => {
    const { s, npc, partner, deal } = setup(31, partnerIsPlayer);
    const guilty: Array<[string, string]> = [];
    const real = s.feelGuilt.bind(s);
    s.feelGuilt = (b, w) => { guilty.push([b, w]); real(b, w); };
    s.planAndCarryOutDeals();
    expect(deal.status).toBe("broken");
    expect(s.live.dealPlans![deal.id]![npc]!.outcome).toBe("carried-out");
    expect(guilty).toEqual([[npc, partner]]);
    const why = (s.live.decisionWhy ?? []).filter((w) => w.by === npc && w.kind === "deal-break");
    expect(why).toHaveLength(1);
    expect(why[0]!.options[0]!.option).toBe(partner);
    const stated = (s.live.statedReasons ?? []).filter((r) => r.decider === npc && r.decision === "deal-break");
    expect(stated.every((r) => r.public === false)).toBe(true); // never voiced aloud
  });

  it("an NPC wronged side holds a lied-to-me claim about the breaker once it learns, and not before", () => {
    const { s, npc, partner, deal } = setup(32, partnerIsPlayer);
    s.planAndCarryOutDeals();
    const holds = (): boolean => (s.live.beliefs?.[partner] ?? []).some((b) => b.kind === "lied-to-me" && b.subject === npc && b.value);
    expect(holds()).toBe(false); // a quiet break: the wronged side does not know yet
    s.deals.learnOfBreak(deal, { learned: (w: string, b: string, d: Deal) => s.learnedBreakClaim(w, b, d) });
    // the player's own read is theirs to form: never a hidden claim about the player as holder
    expect(holds()).toBe(!partnerIsPlayer);
  });
});

describe("a headless season never plants the learned-break claim", () => {
  it("learnedBreakClaim writes nothing when the game is not a played one", () => {
    const { s, npc, partner, deal } = setup(33, false);
    s.live.playedGame = false;
    s.learnedBreakClaim(partner, npc, deal);
    expect((s.live.beliefs?.[partner] ?? []).some((b) => b.kind === "lied-to-me")).toBe(false);
  });
});
