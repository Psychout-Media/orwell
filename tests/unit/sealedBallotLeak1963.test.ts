import { describe, it, expect } from "vitest";
import { DealLedger, type ReconcileSink } from "../../src/engine/deals";
import { RelationshipModel } from "../../src/engine/relationships";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/**
 * #1963 — a deal broken through a SECRET eviction ballot must not be attributable by ANY hidden fold. The wronged
 * party's hidden read of the breaker used to take the full betrayal shock, so their later behaviour (noms, votes, deals)
 * named exactly who voted against them. Now the shock is shared across everyone who could have cast it, and no
 * jury-management demerit names the breaker. A public break (a nomination) is still attributed. Roles only.
 */
const [wronged, breaker, other1, other2] = [npc(1), npc(2), npc(3), npc(4)];

function breakDeal(kind: "vote-evict" | "nominate", opts: { sealed: boolean; suspects?: EntityId[] }) {
  const rel = new RelationshipModel(0.5);
  const ledger = new DealLedger();
  ledger.make([wronged, breaker], "safety", "keep each other safe", undefined, 1);
  const demerits: Array<[EntityId, EntityId]> = [];
  const sink: ReconcileSink = {
    rel, rng: new SeededRandom(7), currentWeek: 2,
    juryDemerit: (w, b) => demerits.push([w, b]),
    ...(opts.sealed ? { sealed: (_w: EntityId, _b: EntityId, _k: string) => true, suspects: () => opts.suspects ?? [] } : {}),
  };
  const before = (to: EntityId): number => rel.edge(wronged, to).trust;
  const t0 = new Map([breaker, other1, other2].map((id) => [id, before(id)]));
  const { broken } = ledger.reconcile({ actor: breaker, kind, targets: [wronged] }, sink);
  expect(broken.length).toBe(1);
  const drop = (to: EntityId): number => t0.get(to)! - before(to);
  return { drop, demerits };
}

describe("a sealed-ballot deal break does not single out the breaker (#1963)", () => {
  it("control: an attributed (public) break lands wholly on the breaker, and names them for the jury", () => {
    const { drop, demerits } = breakDeal("nominate", { sealed: false });
    expect(drop(breaker)).toBeGreaterThan(0);
    expect(drop(other1)).toBe(0);
    expect(demerits).toEqual([[wronged, breaker]]);
  });

  it("sealed: the shock is shared across every possible voter, so the breaker is not the only one the wronged party turns on", () => {
    const control = breakDeal("nominate", { sealed: false }).drop(breaker);
    const { drop, demerits } = breakDeal("vote-evict", { sealed: true, suspects: [breaker, other1, other2] });
    expect(drop(other1)).toBeGreaterThan(0); // the innocent suspects take a share too
    expect(drop(other2)).toBeGreaterThan(0);
    expect(drop(breaker)).toBeLessThan(control); // and the real breaker takes only its share
    // indistinguishable within the temperature jitter: the breaker's drop is within the suspects' range, not an outlier
    const spread = [drop(other1), drop(other2)];
    expect(drop(breaker) / Math.max(...spread)).toBeLessThan(2.5);
    expect(demerits).toEqual([]); // no jury-management demerit names the breaker either
  });

  it("sealed with no known suspects: the pool always contains the breaker (the shock is never dropped)", () => {
    const { drop } = breakDeal("vote-evict", { sealed: true, suspects: [] });
    expect(drop(breaker)).toBeGreaterThan(0);
  });
});

describe("the live adapter wires the sealed predicate and the suspects (#1963)", () => {
  type Priv = {
    live: { eviction?: { voteOf: Record<EntityId, EntityId> } };
    deals: { make(p: [EntityId, EntityId], kind: string, terms: string, ev?: string, week?: number): unknown };
    reconcileDeals(a: { actor: EntityId; kind: string; targets: readonly EntityId[] }): void;
    reconcileAllianceBetrayals(a: { actor: EntityId; kind: string; targets: readonly EntityId[] }): void;
  };
  function house(seed: number) {
    const rel = new RelationshipModel(0.5);
    const session = new GameSessionAdapter(rel);
    session.createCharacter({ playerName: "The Player", seed });
    const ids = (session.snapshot().house?.npcs ?? []).map((n) => n.id);
    return { session, rel, ids, p: session as unknown as Priv };
  }

  it("an NPC's sealed vote-evict break shares the shock with every voter who voted to evict the wronged party", () => {
    const { rel, ids, p } = house(71);
    const [w, b, v1, v2] = [ids[0]!, ids[1]!, ids[2]!, ids[3]!];
    p.live.eviction = { voteOf: { [b]: w, [v1]: w, [v2]: w } } as never;
    p.deals.make([w, b], "safety", "keep each other safe", undefined, 1);
    const before = new Map([b, v1, v2].map((id) => [id, rel.edge(w, id).trust]));
    p.reconcileDeals({ actor: b, kind: "vote-evict", targets: [w] });
    for (const id of [b, v1, v2]) expect(rel.edge(w, id).trust, `suspect ${id} shares the shock`).toBeLessThan(before.get(id)!);
  });

  it("a break WHERE THE PLAYER IS THE WRONGED PARTY keeps the full fold (nothing acts on the player's hidden read)", () => {
    const { rel, ids, p } = house(73);
    const [b, v1] = [ids[0]!, ids[1]!];
    p.live.eviction = { voteOf: { [b]: PLAYER, [v1]: PLAYER } } as never;
    p.deals.make([PLAYER, b], "safety", "keep each other safe", undefined, 1);
    const [bb, b1] = [rel.edge(PLAYER, b).trust, rel.edge(PLAYER, v1).trust];
    p.reconcileDeals({ actor: b, kind: "vote-evict", targets: [PLAYER] });
    expect(rel.edge(PLAYER, b).trust).toBeLessThan(bb);
    expect(rel.edge(PLAYER, v1).trust).toBe(b1); // not spread: the player-wronged path is unchanged
  });

  it("the Final-3 vote has NO staged weekly ballot, so it is a public, attributed break (and a stale ballot never attributes a later one)", () => {
    const { rel, ids, p } = house(74);
    const [w, b, v1] = [ids[0]!, ids[1]!, ids[2]!];
    p.live.eviction = undefined; // no secret ballot exists for the open final-HOH vote
    p.deals.make([w, b], "safety", "keep each other safe", undefined, 1);
    const [bb, b1] = [rel.edge(w, b).trust, rel.edge(w, v1).trust];
    p.reconcileDeals({ actor: b, kind: "vote-evict", targets: [w] });
    expect(rel.edge(w, b).trust).toBeLessThan(bb); // attributed to the breaker alone
    expect(rel.edge(w, v1).trust).toBe(b1);
    // a ballot that exists but does NOT show the breaker voting for the wronged party must not seal their break either
    const c = house(75);
    const [w2, b2, v2] = [c.ids[0]!, c.ids[1]!, c.ids[2]!];
    c.p.live.eviction = { voteOf: { [v2]: w2 } } as never; // the breaker (b2) is not on the current ballot
    c.p.deals.make([w2, b2], "safety", "keep each other safe", undefined, 1);
    const before2 = c.rel.edge(w2, v2).trust;
    c.p.reconcileDeals({ actor: b2, kind: "vote-evict", targets: [w2] });
    expect(c.rel.edge(w2, v2).trust).toBe(before2); // v2 is NOT blamed for b2's break
  });

  it("an alliance betrayal tied to the sealed ballot is shared across the voters and records no demerit; a public one is attributed", () => {
    const sealedRun = (sealedBallot: boolean) => {
      const { rel, ids, p, session } = house(sealedBallot ? 76 : 77);
      const [w, b, v1] = [ids[0]!, ids[1]!, ids[2]!];
      (session as unknown as { alliances: { add(n: string, f: EntityId, m: EntityId[], beat: number): unknown } }).alliances.add("a", w, [w, b], 1);
      p.live.eviction = (sealedBallot ? { voteOf: { [b]: w, [v1]: w } } : undefined) as never;
      const [tb, tv] = [rel.edge(w, b).threat, rel.edge(w, v1).threat];
      p.reconcileAllianceBetrayals({ actor: b, kind: sealedBallot ? "vote-evict" : "nominate", targets: [w] });
      return { dB: rel.edge(w, b).threat - tb, dV: rel.edge(w, v1).threat - tv, manner: (p.live as { mannerByEvictee?: Record<string, Record<string, unknown>> }).mannerByEvictee?.[w]?.[b] };
    };
    const pub = sealedRun(false);
    expect(pub.dB).toBeGreaterThan(0);
    expect(pub.dV).toBe(0);
    expect(pub.manner).toBeDefined(); // the attributed betrayal records the jury demerit
    const sealed = sealedRun(true);
    expect(sealed.dV).toBeGreaterThan(0); // shared with the other voter
    expect(sealed.dB).toBeLessThan(pub.dB); // the real betrayer carries only its share
    expect(sealed.manner).toBeUndefined(); // no demerit names them
  });

  it("the PLAYER's own vote is never sealed from themselves: the break lands on the player alone", () => {
    const { rel, ids, p } = house(72);
    const [w, v1] = [ids[0]!, ids[2]!];
    p.live.eviction = { voteOf: { [PLAYER]: w, [v1]: w } } as never;
    p.deals.make([w, PLAYER], "safety", "keep each other safe", undefined, 1);
    const [bp, b1] = [rel.edge(w, PLAYER).trust, rel.edge(w, v1).trust];
    p.reconcileDeals({ actor: PLAYER, kind: "vote-evict", targets: [w] });
    expect(rel.edge(w, PLAYER).trust).toBeLessThan(bp);
    expect(rel.edge(w, v1).trust).toBe(b1); // an innocent voter is not touched
  });
});
