import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { DealRefusal, DealView } from "../../src/ports/GameSession";

/**
 * ORW-88 / 0142 idea 1 - counteroffers. A houseguest who refuses ONLY because the ask is too dear answers with the cheaper safety pact they would take, as the standing open
 * `dealOffer` (the 0123 pattern; no pop-up). Played games only. Accept makes an ordinary deal; a decline makes none; no offer when the ask was refused for another reason, when nobody
 * is playing, or when the layer is off. Roles only.
 */
type Internals = {
  rel: { edge(a: string, b: string): { trust: number; affinity: number; threat: number } };
  live: { playedGame?: boolean; dealOffer?: { from: string; kind: string } };
  dealConsentRefusal(npc: string, kind: string, direction?: "offer" | "ask"): DealRefusal | null;
  setNpcDealOffersEnabled(on: boolean): void;
  setNpcDealConsentEnabled(on: boolean): void;
  setDealDepthEnabled(on: boolean): void;
};

function lukewarm(played: boolean, offersOn = true) {
  const sb = new GameSessionRegistry().sandboxFor(`counter-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const g = sb.session as unknown as Internals;
  g.setNpcDealConsentEnabled(true);
  g.setDealDepthEnabled(true);
  g.setNpcDealOffersEnabled(offersOn);
  g.live.playedGame = played;
  const npc = [...sb.session.livingIds()].find((i) => i !== PLAYER)!;
  // a typical-newcomer read (no drag) refuses an ask to throw a comp for COST alone, yet takes a mutual safety pact
  const e = g.rel.edge(npc, PLAYER);
  e.trust = 0.25; e.affinity = 0.25; e.threat = 0.3;
  expect(g.dealConsentRefusal(npc, "comp-throw", "ask")?.reason).toBe("cost");
  expect(g.dealConsentRefusal(npc, "safety")).toBeNull();
  return { sb, g, npc };
}
const ask = (sb: ReturnType<typeof lukewarm>["sb"], npc: string) => sb.session.makeDeal({ with: npc, kind: "comp-throw", direction: "ask", terms: "throw the next comp" } as never) as DealRefusal | DealView | null;
const dealsWith = (sb: ReturnType<typeof lukewarm>["sb"], npc: string) => (sb.session.getGameState().deals ?? []).filter((d) => d.parties.some((p) => p.id === npc)).length;

describe("a lukewarm houseguest counters instead of a flat no", () => {
  it("a played game: the cost refusal carries a counteroffer that stands as open state, and accepting makes an ordinary deal", () => {
    const { sb, g, npc } = lukewarm(true);
    const r = ask(sb, npc) as DealRefusal;
    expect(r.refused).toBe(true);
    expect(r.counteroffer?.kind).toBe("safety");
    expect(g.live.dealOffer?.from).toBe(npc);
    expect(sb.session.getGameState().openDealOffer?.from.id).toBe(npc);
    expect(sb.session.getGameState().pending?.kind).not.toBe("deal-offer"); // never a pop-up
    expect(dealsWith(sb, npc)).toBe(0);
    sb.session.submitDecision({ kind: "deal-offer", vote: "accept" } as never);
    expect(dealsWith(sb, npc)).toBe(1);
    expect(sb.session.getGameState().openDealOffer).toBeUndefined();
  });
  it("declining the counteroffer makes no deal", () => {
    const { sb, npc } = lukewarm(true);
    ask(sb, npc);
    sb.session.submitDecision({ kind: "deal-offer", vote: "decline" } as never);
    expect(dealsWith(sb, npc)).toBe(0);
  });
  it("a game nobody is playing, or the offer layer off, stays a plain refusal (byte-identical)", () => {
    for (const [played, on] of [[false, true], [true, false]] as const) {
      const { sb, g, npc } = lukewarm(played, on);
      const r = ask(sb, npc) as DealRefusal;
      expect(r.refused).toBe(true);
      expect(r.counteroffer).toBeUndefined();
      expect(g.live.dealOffer).toBeUndefined();
    }
  });
  it("a refusal for another reason (distrust) does not counter", () => {
    const { sb, g, npc } = lukewarm(true);
    const e = g.rel.edge(npc, PLAYER);
    e.trust = 0; e.affinity = 0; e.threat = 0.9;
    const r = ask(sb, npc) as DealRefusal;
    expect(r.refused).toBe(true);
    expect(r.counteroffer).toBeUndefined();
  });
});
