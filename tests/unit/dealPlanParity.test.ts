import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { Drive } from "../../src/engine/campaigns";

/**
 * ORW-613 (Fable's player-plugged-in sweep): a houseguest weighs breaking a deal with another houseguest exactly as they weigh breaking one with the player. Their own
 * push against the other party (campaign, else drive) used to count only when the partner was the player, so NPCs broke deals with the player more readily than
 * each other's. TEST-ONLY seams: the drives, the live season, the deal ledger, the adapter's private push read and plan step. Roles only.
 */
type Seam = {
  drives: Map<string, Drive>;
  live: { playedGame?: boolean; week: number };
  deals: { make(parties: [string, string], kind: string, terms: string, madeEventId?: string, madeWeek?: number): unknown };
  ownPushAgainst(npc: string, target: string): number;
  planAndCarryOutDeals(): void;
};

function sandbox(seed: number) {
  const sb = new GameSessionRegistry().sandboxFor(`parity-${seed}`);
  sb.session.setDealPlansEnabled(true);
  sb.session.createCharacter({ playerName: "The Player", seed });
  const s = sb.session as unknown as Seam;
  s.live.playedGame = true;
  const [holder, other] = sb.session.livingIds().filter((id) => id !== PLAYER);
  return { s, holder: holder!, other: other! };
}

describe("ORW-613: deal-break weighing is the same toward the player and toward a houseguest", () => {
  it("the same drive gives the same push, whoever it points at", () => {
    const { s, holder, other } = sandbox(41);
    s.drives.set(holder, { owner: holder, motivation: "target", target: other, intensity: 0.8 });
    const atNpc = s.ownPushAgainst(holder, other);
    s.drives.set(holder, { owner: holder, motivation: "target", target: PLAYER, intensity: 0.8 });
    const atPlayer = s.ownPushAgainst(holder, PLAYER);
    expect(atNpc).toBeGreaterThan(0);
    expect(atNpc).toBeCloseTo(atPlayer, 12);
  });
  it("the plan for a deal with a houseguest reads the holder's push against that houseguest", () => {
    const { s, holder, other } = sandbox(42);
    const asked: Array<[string, string]> = [];
    const real = s.ownPushAgainst.bind(s);
    s.ownPushAgainst = (n, t) => { asked.push([n, t]); return real(n, t); };
    s.deals.make([holder, other], "vote", "a vote deal between two houseguests", undefined, s.live.week);
    s.planAndCarryOutDeals();
    expect(asked).toContainEqual([holder, other]);
  });
});
