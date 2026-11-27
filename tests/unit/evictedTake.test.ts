import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { EVICTED_TAKE, heirOf, partnerReaction, debtorRelief } from "../../src/engine/evictedTake";
import { FavorLedger } from "../../src/engine/favors";

/**
 * 0195 (ORW-628): what the evicted take with them. Their open deals lapse, a favor owed to them passes to their closest ally or lapses, a favor they owed lapses,
 * their assurances lapse, and the ones left react (relief / worry). The player in both directions. Drives the REAL adapter. Roles only.
 */
type Deal = { id: string; status: string; kind: string; parties: string[] };
type Seam = {
  live: { playedGame?: boolean; week: number; active: string[]; evictionOrder: string[]; pending?: unknown; dealPlans?: Record<string, Record<string, { kind: string; madeWeek: number }>>; assurances?: { seq: number; items: Array<{ from: string; to: string; status: string }> } };
  deals: { make(p: [string, string], k: string, t: string, e?: string, w?: number): Deal; all: Deal[] };
  favors: FavorLedger;
  rel: { applyImpactDirected(h: string, o: string, i: Record<string, number>, rng: { next(): number }): void; bondStrength(a: string, b: string): number };
  evictedTakeWithThem(): void; setEvictedTakeEnabled(on: boolean): void;
  recordAssurance(a: { from: string; to: string; kind: "vote"; sincerity: number; source: "npc" | "player" }): void;
  soulObj(id: string): { emotionalState: number } | undefined;
};
const flat = { next: () => 0.5 };
function setup(seed: number, on = true) {
  const sb = new GameSessionRegistry().sandboxFor(`evtake-${seed}-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed });
  sb.session.advanceGame(); sb.session.advanceGame();
  const g = sb.session as unknown as Seam;
  g.setEvictedTakeEnabled(on);
  g.live.playedGame = true; g.live.pending = undefined;
  const npcs = g.live.active.filter((i) => i !== PLAYER);
  return { g, npcs };
}
const evict = (g: Seam, id: string) => { g.live.active = g.live.active.filter((x) => x !== id); g.live.evictionOrder = [...g.live.evictionOrder, id]; };
const close = (g: Seam, a: string, b: string) => { for (let i = 0; i < 6; i++) g.rel.applyImpactDirected(a, b, { trust: 0.4, affinity: 0.4 }, flat); };
const mood = (g: Seam, id: string) => g.soulObj(id)!.emotionalState;

describe("0195 pure", () => {
  it("the heir is the evictee's closest ally at or above the pass bar, never the debtor; none = it lapses", () => {
    const bond = (_: string, to: string) => ({ a: 0.9, b: 0.7, c: 0.3 } as Record<string, number>)[to] ?? 0;
    expect(heirOf("e", "x", ["a", "b", "c"], bond, 0.6)).toBe("a");
    expect(heirOf("e", "a", ["a", "b", "c"], bond, 0.6)).toBe("b");
    expect(heirOf("e", "x", ["c"], bond, 0.6)).toBeUndefined();
  });
  it("a partner planning to break it is relieved; otherwise worry by how much it shielded them; a debtor's relief is capped", () => {
    expect(partnerReaction("final-two", true)?.kind).toBe("relief");
    expect(partnerReaction("final-two", false)!.scale).toBeGreaterThan(partnerReaction("vote", false)!.scale);
    expect(partnerReaction("target-other", false)).toBeUndefined();
    expect(debtorRelief(10)).toBe(EVICTED_TAKE.reliefCap);
  });
});

describe("0195 in the live adapter", () => {
  it("an NPC evictee's deals lapse; a partner who meant to break it is relieved, one it shielded worries", () => {
    const { g, npcs } = setup(31);
    const [e, liar, shielded] = npcs as [string, string, string];
    const d1 = g.deals.make([e, liar], "final-two", "t", undefined, g.live.week);
    const d2 = g.deals.make([e, shielded], "safety", "t", undefined, g.live.week);
    (g.live.dealPlans ??= {})[d1.id] = { [liar]: { kind: "cut-final-three", madeWeek: g.live.week } };
    const [m1, m2] = [mood(g, liar), mood(g, shielded)];
    evict(g, e);
    g.evictedTakeWithThem();
    expect(g.deals.all.find((d) => d.id === d1.id)!.status).toBe("lapsed");
    expect(g.deals.all.find((d) => d.id === d2.id)!.status).toBe("lapsed");
    expect(mood(g, liar)).toBeGreaterThan(m1);
    expect(mood(g, shielded)).toBeLessThan(m2);
  });

  it("a favor the PLAYER owes an evicted NPC passes to their closest ally, who can now call it in on the player", () => {
    const { g, npcs } = setup(32);
    const [e, ally] = npcs as [string, string];
    close(g, e, ally);
    g.favors.owe({ owedBy: PLAYER, owedTo: e, origin: "t", beat: 1 });
    evict(g, e);
    g.evictedTakeWithThem();
    const held = g.favors.openHeldBy(ally);
    expect(held).toHaveLength(1);
    expect(held[0]!.owedBy).toBe(PLAYER);
    expect(held[0]!.owedTo).toBe(e); // the ledger still remembers whose it was
  });

  it("with no ally to take it, a held favor lapses and the NPC debtor is relieved; a favor the evictee owed lapses", () => {
    const { g, npcs } = setup(33);
    const [e, debtor, creditor] = npcs as [string, string, string];
    g.favors.owe({ owedBy: debtor, owedTo: e, origin: "t", beat: 1 });
    g.favors.owe({ owedBy: e, owedTo: creditor, origin: "t2", beat: 1 });
    const m = mood(g, debtor);
    evict(g, e);
    g.evictedTakeWithThem();
    expect(g.favors.all.filter((f) => f.state === "owed")).toHaveLength(g.favors.openHeldBy(debtor).length + g.favors.all.filter((f) => f.state === "owed" && f.holder !== debtor).length);
    expect(g.favors.openOwedBy(debtor).filter((f) => f.owedTo === e)).toHaveLength(0);
    expect(g.favors.openHeldBy(creditor)).toHaveLength(0);
    expect(g.favors.all.some((f) => f.state === "lapsed")).toBe(true);
    expect(mood(g, debtor)).toBeGreaterThan(m);
  });

  it("the player evicted: the player's held favors lapse (never passed for them), their deals lapse, and NPC debtors are relieved", () => {
    const { g, npcs } = setup(34);
    const [debtor, partner, ally] = npcs as [string, string, string];
    close(g, PLAYER, ally);
    g.favors.owe({ owedBy: debtor, owedTo: PLAYER, origin: "t", beat: 1 });
    const d = g.deals.make([PLAYER, partner], "final-two", "t", undefined, g.live.week);
    const m = mood(g, debtor);
    evict(g, PLAYER);
    g.evictedTakeWithThem();
    expect(g.favors.openHeldBy(ally)).toHaveLength(0);
    expect(g.favors.all.filter((f) => f.owedTo === PLAYER).every((f) => f.state === "lapsed")).toBe(true);
    expect(g.deals.all.find((x) => x.id === d.id)!.status).toBe("lapsed");
    expect(mood(g, debtor)).toBeGreaterThan(m);
  });

  it("open assurances to and from the evictee lapse; once per evictee; flag off changes nothing", () => {
    const { g, npcs } = setup(35);
    const [e, a] = npcs as [string, string];
    g.recordAssurance({ from: e, to: a, kind: "vote", sincerity: 1, source: "npc" });
    g.recordAssurance({ from: a, to: e, kind: "vote", sincerity: 1, source: "npc" });
    evict(g, e);
    g.evictedTakeWithThem();
    expect(g.live.assurances!.items.every((x) => x.status === "lapsed")).toBe(true);
    const snapshot = JSON.stringify(g.deals.all) + JSON.stringify(g.favors.all);
    g.evictedTakeWithThem();
    expect(JSON.stringify(g.deals.all) + JSON.stringify(g.favors.all)).toBe(snapshot);

    const off = setup(36, false);
    const [oe, op] = off.npcs as [string, string];
    const od = off.g.deals.make([oe, op], "final-two", "t", undefined, off.g.live.week);
    evict(off.g, oe);
    off.g.evictedTakeWithThem();
    expect(off.g.deals.all.find((x) => x.id === od.id)!.status).toBe("open");
  });
});

describe("ORW-1097: the Final-3 eviction (atomic, no eviction-result beat) takes the evictee's deals with them too", () => {
  it("committing the final-eviction beat lapses the third-place evictee's open deals and assurances; the Final 2 partner's own deal stays open", () => {
    const { g, npcs } = setup(32);
    const [e, other, f1, f2] = npcs as [string, string, string, string];
    const d1 = g.deals.make([e, other], "final-two", "t", undefined, g.live.week);
    const d2 = g.deals.make([e, other], "target-other", "t", undefined, g.live.week);
    const keep = g.deals.make([f1, f2], "final-two", "t", undefined, g.live.week);
    evict(g, e);
    (g as unknown as { commit(ev: { beat: string; content: string; participants: string[] }): void }).commit({ beat: "final-eviction", content: "x evicts y", participants: [f1, e] });
    expect(g.deals.all.find((d) => d.id === d1.id)!.status).toBe("lapsed");
    expect(g.deals.all.find((d) => d.id === d2.id)!.status).toBe("lapsed");
    expect(g.deals.all.find((d) => d.id === keep.id)!.status).toBe("open");
    expect(g.live.evictionOrder).toContain(e);
  });
});
