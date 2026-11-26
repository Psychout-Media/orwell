import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import type { DealRefusal, DealView } from "../../src/ports/GameSession";
import { playedGame } from "../support/playedGame";
import { firstSeedWhereSync } from "../support/firstSeedWhere";

/**
 * ORW-930 (a playtest: a houseguest asked the player to put a promise in their own words, the player did, and the houseguest then refused to "sign for it"). REAL PATH: a season is played
 * until a houseguest has a deal offer standing with the player. The player takes it up the way a player says yes in words, `makeDeal` to that houseguest with the offer's own kind. The
 * houseguest asked for this deal, so the engine does not re-roll their consent on it: the deal is made, the offer is spent, and no refusal and no cooling follow. Roles only.
 */
const isRefusal = (r: unknown): r is DealRefusal => !!r && (r as DealRefusal).refused === true;

function offerStanding(seed: number, sandbox: string) {
  const g = playedGame({ seed, user: sandbox });
  const open = () => g.s.getGameState() as { openDealOffer?: { id: string; kind: string; from: { id: string } }; week?: number };
  g.playUntil(() => open().openDealOffer !== undefined, 6000, "a standing offer from a houseguest");
  return g;
}

describe("a makeDeal to the houseguest who made the offer accepts it (played)", () => {
  it("the deal is made, not refused; the offer is spent", () => {
    const f = firstSeedWhereSync((seed, sandbox) => offerStanding(seed, sandbox), { from: 1, to: 12, hint: [8, 12], sandbox: (s) => `ao930-${s}`, what: "a houseguest's offer standing with the player" });
    const g = f.at;
    const o = (g.s.getGameState() as { openDealOffer: { id: string; kind: string; from: { id: string } } }).openDealOffer;
    const before = g.s.getGameState().deals?.length ?? 0;
    const r = g.s.makeDeal({ with: o.from.id, kind: o.kind as never, terms: "said back in the player's own words" });
    expect(isRefusal(r), `seed ${f.seed}: the houseguest who offered it refused it`).toBe(false);
    expect((r as DealView).kind).toBe(o.kind);
    expect(g.s.getGameState().deals?.length, "one deal was made").toBe(before + 1);
    expect((g.s.getGameState() as { openDealOffer?: unknown }).openDealOffer, "the offer is spent").toBeUndefined();
    expect((r as DealView).parties.some((x) => x.id === o.from.id), "with the houseguest who offered").toBe(true);
  });

  it("a deal with a houseguest who made no offer is still decided by their own consent (unchanged)", () => {
    // the precondition (a seed scan): a house where someone who made no offer refuses on their own read; whether anyone does is the house's call
    const f = firstSeedWhereSync((seed, sandbox) => {
      const g = offerStanding(seed, sandbox);
      const o = (g.s.getGameState() as { openDealOffer: { from: { id: string } } }).openDealOffer;
      const others = g.s.livingIds().filter((id) => id !== PLAYER && id !== o.from.id);
      const answers = others.map((id) => g.s.makeDeal({ with: id, kind: "safety", terms: "x" }));
      return answers.some((a) => isRefusal(a)) ? g : undefined;
    }, { from: 1, to: 12, hint: [8, 12], sandbox: (s) => `ao930b-${s}`, what: "a standing offer and another houseguest who refuses a safety deal on their own read" });
    const g = f.at;
    expect((g.s.getGameState() as { openDealOffer?: unknown }).openDealOffer, "their offer still stands").toBeDefined();
  });
});
