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
    const f = firstSeedWhereSync((seed, sandbox) => offerStanding(seed, sandbox), { from: 1, to: 12, hint: [1, 8, 12], sandbox: (s) => `ao930-${s}`, what: "a houseguest's offer standing with the player" });
    const g = f.at;
    const o = (g.s.getGameState() as { openDealOffer: { id: string; kind: string; from: { id: string } } }).openDealOffer;
    const before = g.s.getGameState().deals?.length ?? 0;
    const r = g.s.makeDeal({ with: o.from.id, kind: o.kind as never, terms: "said back in the player's own words" });
    expect(isRefusal(r), `seed ${f.seed}: the houseguest who offered it refused it`).toBe(false);
    expect((r as DealView).kind).toBe(o.kind);
    expect(g.s.getGameState().deals?.length, "one deal was made").toBe(before + 1);
    // ORW-1079: the ANSWERED offer is spent (another houseguest's own offer may stand next; that is theirs, not this one)
    expect((g.s.getGameState() as { openDealOffer?: { id: string } }).openDealOffer?.id, "the offer is spent").not.toBe(o.id);
    expect((r as DealView).parties.some((x) => x.id === o.from.id), "with the houseguest who offered").toBe(true);
  }, 120_000); // a whole played season: past the 30 s default on a CI runner

  it("a deal with a houseguest who made no offer is still decided by their own consent (unchanged)", () => {
    const f = firstSeedWhereSync((seed, sandbox) => offerStanding(seed, sandbox), { from: 1, to: 12, hint: [8, 12], sandbox: (s) => `ao930b-${s}`, what: "a houseguest's offer standing with the player" });
    const g = f.at;
    const o = (g.s.getGameState() as { openDealOffer: { from: { id: string } } }).openDealOffer;
    const others = g.s.livingIds().filter((id) => id !== PLAYER && id !== o.from.id);
    const answers = others.map((id) => g.s.makeDeal({ with: id, kind: "safety", terms: "x" }));
    expect(answers.some((a) => isRefusal(a)), "someone else still refuses on their own read").toBe(true);
    expect((g.s.getGameState() as { openDealOffer?: unknown }).openDealOffer, "their offer still stands").toBeDefined();
  });
});
