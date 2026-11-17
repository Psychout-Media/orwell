import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { Deal } from "../../src/domain/deal";
import { recordPlan, type PlanStore } from "../../src/engine/dealPlans";

/**
 * Feature 0178 - the flip at the vote (Fable T3-5 item 4). A flip plan casts the holder's vote against the other party unless something bigger has happened
 * since; a RECOMMIT (a newer deal between the two) is bigger even when it is made the same week as the deal the plan is for. TEST-ONLY seams: the live season,
 * the deal ledger, the adapter's season context. Roles only: a houseguest, the player.
 */
type Seam = {
  live: { playedGame?: boolean; dealPlans?: PlanStore; week: number; beat: string };
  deals: { make(parties: [string, string], kind: string, terms: string, madeEventId?: string, madeWeek?: number): Deal };
  ctx(): { flipVoteFor?: (v: string, fn: readonly [string, string]) => string | undefined };
};

function setup(seed: number) {
  const sb = new GameSessionRegistry().sandboxFor(`flip-${seed}`);
  sb.session.setDealPlansEnabled(true);
  sb.session.createCharacter({ playerName: "The Player", seed });
  const s = sb.session as unknown as Seam;
  s.live.playedGame = true;
  const [npc, other] = sb.session.livingIds().filter((id) => id !== PLAYER);
  const deal = s.deals.make([npc!, PLAYER], "vote", "a vote deal", undefined, s.live.week);
  recordPlan((s.live.dealPlans ??= {}), deal.id, npc!, { kind: "flip", moment: { week: s.live.week, at: "vote" } }, s.live.week);
  s.live.beat = "eviction";
  return { s, npc: npc!, other: other! };
}

describe("the flip at the vote (0178)", () => {
  it("a flip plan casts the vote against the player", () => {
    const { s, npc, other } = setup(21);
    expect(s.ctx().flipVoteFor?.(npc, [PLAYER, other])).toBe(PLAYER);
  });
  it("a recommit made the SAME week cancels the flip (the newer deal stands)", () => {
    const { s, npc, other } = setup(22);
    s.deals.make([PLAYER, npc], "vote", "we recommit", undefined, s.live.week);
    expect(s.ctx().flipVoteFor?.(npc, [PLAYER, other])).toBeUndefined();
  });
  it("a deal with someone else does not cancel it", () => {
    const { s, npc, other } = setup(23);
    s.deals.make([npc, other], "vote", "a deal with a third houseguest", undefined, s.live.week);
    expect(s.ctx().flipVoteFor?.(npc, [PLAYER, other])).toBe(PLAYER);
  });
});
