import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import { dealTermIllegal, voteTermIllegal, duplicateLiveDeal } from "../../src/engine/dealLegality";
import type { DealRefusal } from "../../src/ports/GameSession";

/**
 * ORW-727 - a deal term must fit the powers its giver really holds this week, and the same pair cannot hold the same live deal twice. Roles only.
 * The pure rules first, then the played path through `makeDeal` (the closed-set refusal is typed and Vault-free) and the NPC-offered swaps.
 */
describe("the pure legality rules", () => {
  const week = { hoh: "h", nominees: ["n1", "n2"], nominationsMade: true } as const;
  it("the HOH has no vote to give, and a nominee has none either", () => {
    expect(voteTermIllegal("h", "n1", week)).toBe("no-vote-power");
    expect(voteTermIllegal("n2", "n1", week)).toBe("no-vote-power");
    expect(voteTermIllegal("v", "n1", week)).toBeUndefined();
  });
  it("a houseguest off the block cannot be kept safe from this eviction; before the nominations anyone can", () => {
    expect(voteTermIllegal("v", "off", week)).toBe("not-at-risk");
    expect(voteTermIllegal("v", "h", week)).toBe("not-at-risk");
    expect(voteTermIllegal("v", "off", { hoh: "h", nominees: [], nominationsMade: false })).toBeUndefined();
  });
  it("a mutual vote deal stands while one direction can be kept; only the vote kind is checked", () => {
    expect(dealTermIllegal("vote", "v", "n1", week)).toBeUndefined();
    expect(dealTermIllegal("vote", "h", "off", week)).toBe("no-vote-power");
    expect(dealTermIllegal("safety", "h", "off", week)).toBeUndefined();
  });
  it("a second live deal of the same kind between the pair this week is a duplicate; another week or kind is not", () => {
    const deals = [{ id: "d1", parties: ["p", "x"], kind: "safety", status: "open", madeWeek: 2 }] as const;
    expect(duplicateLiveDeal(deals, "safety", "x", "p", 2)?.id).toBe("d1");
    expect(duplicateLiveDeal(deals, "safety", "p", "x", 3)).toBeUndefined();
    expect(duplicateLiveDeal(deals, "vote", "p", "x", 2)).toBeUndefined();
    expect(duplicateLiveDeal(deals, "safety", "p", "x", 2, "d1")).toBeUndefined();
  });
});

type Seam = { live: { hoh?: string; nominees?: [string, string]; finalNominees?: [string, string]; beat: string; week: number }; deals: { all: readonly { kind: string; status: string }[] }; house: { npcs: { id: string }[] } };

function game(seed = 5) {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(`orw727-${seed}`);
  sb.session.createCharacter({ playerName: "The Player", seed });
  const s = sb.session as unknown as GameSessionAdapter;
  const seam = s as unknown as Seam;
  // Drive until an HOH is crowned and the nominations are in (the veto competition is next).
  for (let i = 0; i < 80 && !(seam.live.nominees && seam.live.hoh); i++) {
    const v = sb.session.advanceGame();
    const p = v.pending;
    if (p?.kind === "nominations") sb.session.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
    else if (p?.kind === "comp-round") sb.session.submitDecision({ kind: "comp-round", intent: "compete" });
    else if (p) sb.session.submitDecision({ kind: p.kind, vote: p.options?.[0]?.id } as never);
  }
  return { s, seam };
}

describe("makeDeal refuses a vote term the offerer cannot keep, with a typed Vault-free reason", () => {
  it("a sitting HOH cannot swear a vote to keep a houseguest off the block who is not exposed", () => {
    const { s, seam } = game();
    const hoh = seam.live.hoh!;
    // The player is not a nominee (nominees are NPCs here); an HOH partner has no vote and the player is not on the block: neither direction is keepable.
    expect(seam.live.nominees).toBeDefined();
    expect(seam.live.nominees!.includes(PLAYER)).toBe(false);
    expect(hoh, "this seed crowns an NPC HOH").not.toBe(PLAYER);
    const r = s.makeDeal({ with: hoh, kind: "vote", terms: "I vote to keep you safe" }) as DealRefusal;
    expect(r.refused).toBe(true);
    expect(r.illegal).toBeDefined();
    expect(["no-vote-power", "not-at-risk"]).toContain(r.illegal);
    expect(Object.keys(r).sort()).toEqual(["illegal", "refused"]); // no number, no reason of theirs, nothing hidden
    expect(seam.deals.all.filter((d) => d.kind === "vote")).toHaveLength(0);
  });

  it("a player who is not on the block cannot be kept safe from this eviction by anyone", () => {
    const { s, seam } = game();
    const voter = seam.house.npcs.map((n) => n.id).find((id) => id !== seam.live.hoh && !seam.live.nominees!.includes(id))!;
    const r = s.makeDeal({ with: voter, kind: "vote", terms: "vote to keep each other safe" }) as DealRefusal;
    expect(r.refused).toBe(true);
    expect(r.illegal).toBe("not-at-risk");
  });

  it("the same refusal comes back for a repeat of the same keyed call, and nothing was recorded", () => {
    const { s, seam } = game();
    const voter = seam.house.npcs.map((n) => n.id).find((id) => id !== seam.live.hoh && !seam.live.nominees!.includes(id))!;
    const a = s.makeDeal({ with: voter, kind: "vote", terms: "x", idempotencyKey: "k1" });
    const b = s.makeDeal({ with: voter, kind: "vote", terms: "x", idempotencyKey: "k1" });
    expect(b).toEqual(a);
    expect(seam.deals.all).toHaveLength(0);
  });
});

describe("the houseguests' own swap offers obey the same rules", () => {
  it("the sitting HOH is never the giver of a lighter vote term, and a vote term toward a houseguest off the block is not offered", () => {
    const { s, seam } = game();
    const blocked = (kind: string, giver: string, other: string) => (s as unknown as { offeredDealBlocked(k: string, g: string, o: string): boolean }).offeredDealBlocked(kind, giver, other);
    expect(blocked("vote", seam.live.hoh!, PLAYER)).toBe(true); // the HOH has no vote
    const voter = seam.house.npcs.map((n) => n.id).find((id) => id !== seam.live.hoh && !seam.live.nominees!.includes(id))!;
    expect(blocked("vote", voter, PLAYER)).toBe(true); // the player is not on the block
    expect(blocked("vote", voter, seam.live.nominees![0]!)).toBe(false); // a nominee can be kept safe by a voter
  });
});

describe("one live deal per pair and term", () => {
  it("a second live safety deal with the same houseguest this week is refused, however it is asked", () => {
    const { s, seam } = game();
    const npc = seam.house.npcs.map((n) => n.id).find((id) => id !== seam.live.hoh)!;
    // Seat one live deal straight in the ledger, then ask for the same one through the lever.
    (s as unknown as { deals: { make: (...a: unknown[]) => unknown } }).deals.make([PLAYER, npc], "safety", "we keep each other safe", undefined, seam.live.week);
    const before = seam.deals.all.length;
    const r = s.makeDeal({ with: npc, kind: "safety", terms: "we keep each other safe" }) as DealRefusal;
    expect(r.refused).toBe(true);
    expect(r.illegal).toBe("already-live");
    expect(seam.deals.all).toHaveLength(before);
  });
});
