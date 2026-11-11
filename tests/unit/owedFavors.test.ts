import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";

/**
 * ORW-88 / 0142 idea 2 - owed favors you can call in. A deal an NPC KEPT with the player banks a favor (played games only); the player can call it in; the engine prices whether it is
 * honored (a marginal active ask is tipped by the favor, a distrusted/feared player is still refused) and ignoring it costs the player's own read of them. Roles only.
 */
type Internals = {
  rel: { edge(a: string, b: string): { trust: number; affinity: number; threat: number } };
  live: { playedGame?: boolean; owedFavors?: Array<{ debtor: string; n: number; madeWeek: number }> };
  bankOwedFavor(honorer: string, honored: string): void;
  setNpcDealConsentEnabled(on: boolean): void;
  setDealDepthEnabled(on: boolean): void;
};
function game(played = true) {
  const sb = new GameSessionRegistry().sandboxFor(`favor-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const g = sb.session as unknown as Internals;
  g.setNpcDealConsentEnabled(true); g.setDealDepthEnabled(true);
  g.live.playedGame = played;
  const npc = [...sb.session.livingIds()].find((i) => i !== PLAYER)!;
  return { s: sb.session, g, npc };
}
const dealsWith = (s: ReturnType<typeof game>["s"], npc: string) => (s.getGameState().deals ?? []).filter((d) => d.parties.some((p) => p.id === npc));

describe("banking", () => {
  it("a kept deal banks a favor owed to the player (played game), capped at 3, and it shows on the state view", () => {
    const { s, g, npc } = game();
    for (let i = 0; i < 5; i++) g.bankOwedFavor(npc, PLAYER);
    expect(g.live.owedFavors).toEqual([{ debtor: npc, n: 3, madeWeek: expect.any(Number) }]);
    expect(s.getGameState().owedFavors?.[0]?.n).toBe(3);
    expect(s.getGameState().owedFavors?.[0]?.from.id).toBe(npc);
  });
  it("banks nothing for a game nobody plays, for a favor owed BY the player, or between NPCs", () => {
    const a = game(false); a.g.bankOwedFavor(a.npc, PLAYER);
    expect(a.g.live.owedFavors).toBeUndefined();
    expect(a.s.getGameState().owedFavors).toBeUndefined();
    const b = game(); b.g.bankOwedFavor(PLAYER, b.npc); b.g.bankOwedFavor(b.npc, b.npc);
    expect(b.g.live.owedFavors).toBeUndefined();
  });
});

describe("end to end: a deal played to KEPT banks the favor", () => {
  type Dealer = Internals & { deals: { make(parties: [string, string], kind: string, terms: string, ev: string | undefined, week: number): { status: string } }; reconcileDeals(a: unknown): void };
  it("an NPC who throws the comp they promised the player owes the player a favor (played game); not in a game nobody plays", () => {
    for (const played of [true, false]) {
      const { g, npc } = game(played);
      const d = g as unknown as Dealer;
      const deal = d.deals.make([npc, PLAYER], "comp-throw", "throw it", undefined, 1);
      d.reconcileDeals({ actor: npc, kind: "compete", targets: [], outcome: "threw" });
      expect(deal.status).toBe("kept");
      if (played) expect(d.live.owedFavors?.[0]).toMatchObject({ debtor: npc, n: 1 });
      else expect(d.live.owedFavors).toBeUndefined();
    }
  });
});

describe("calling a favor in", () => {
  it("null when nothing is owed, or nobody is playing", () => {
    const a = game();
    expect(a.s.callInFavor(a.npc, "vote")).toBeNull();
    const b = game(false); b.g.live.owedFavors = [{ debtor: b.npc, n: 1, madeWeek: 1 }];
    expect(b.s.callInFavor(b.npc, "vote")).toBeNull();
  });
  it("a marginal active ask the NPC would refuse is honored because of the favor: an ordinary deal binds and the favor is spent", () => {
    const { s, g, npc } = game();
    const e = g.rel.edge(npc, PLAYER); e.trust = 0.25; e.affinity = 0.25; e.threat = 0.3; // a typical newcomer read
    const plain = s.makeDeal({ with: npc, kind: "comp-throw", direction: "ask", terms: "throw it" } as never) as { refused?: boolean };
    expect(plain.refused, "without the favor the ask is refused for cost").toBe(true);
    g.bankOwedFavor(npc, PLAYER);
    const r = s.callInFavor(npc, "comp-throw")!;
    expect(r.honored).toBe(true);
    expect(dealsWith(s, npc)).toHaveLength(1);
    expect(g.live.owedFavors).toBeUndefined();
    expect(s.callInFavor(npc, "comp-throw")).toBeNull(); // spent
  });
  it("a feared/distrusted player is still refused: no deal, the favor is spent, and the player's read of them drops", () => {
    const { s, g, npc } = game();
    const e = g.rel.edge(npc, PLAYER); e.trust = 0; e.affinity = 0; e.threat = 0.95;
    g.bankOwedFavor(npc, PLAYER);
    const before = g.rel.edge(PLAYER, npc).trust;
    const r = s.callInFavor(npc, "vote")!;
    expect(r.honored).toBe(false);
    expect(dealsWith(s, npc)).toHaveLength(0);
    expect(g.live.owedFavors).toBeUndefined();
    expect(g.rel.edge(PLAYER, npc).trust).toBeLessThan(before);
  });
});
