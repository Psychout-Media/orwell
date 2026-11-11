import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { RelationshipModel } from "../../src/engine/relationships";
import type { EntityId } from "../../src/domain/ids";
import { PLAYER } from "../../src/domain/ids";
import { resolvePending } from "../../features/support/answerPending";
import { playSeasonOutcome } from "../../features/support/seasonOutcome";

/**
 * ORW-111 (0110): the eviction grudge lands on the BELIEVED voter, never the true one. A real live eviction is committed through the adapter (`commitStagedEviction`) on a CRAFTED secret ballot where the
 * true defector is the houseguest the evictee trusts most (so is NOT among the most suspected) and a houseguest who voted to keep them is highly suspected. The jury-management manner row is the grudge
 * (`mannerByEvictee[evictee]`). Mutant: fold the true ballot (`believedVoters = votesToEvict`) -> the defector is blamed and the suspected-but-innocent is not -> red. Roles only.
 */
type Priv = {
  live: {
    week: number; hoh?: EntityId; active: EntityId[];
    eviction?: { stage: string; nominees: [EntityId, EntityId]; revealOrder: EntityId[]; voteOf: Record<EntityId, EntityId>; revealIx: number; goodbyeFrom: EntityId[]; goodbyeIx: number };
    mannerByEvictee?: Record<EntityId, Record<EntityId, unknown>>;
  };
};

function toEviction(seed: number, rel: RelationshipModel, on: boolean): GameSessionAdapter {
  const s = new GameSessionAdapter(rel);
  s.createCharacter({ playerName: "P", seed });
  s.setVoteDeductionEnabled(on);
  const p = s as unknown as Priv;
  for (let i = 0; i < 4000; i++) {
    const v = s.advanceGame();
    if (p.live.eviction && p.live.eviction.stage === "votes") return s;
    if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
    if (v.finished) break;
  }
  throw new Error("no eviction reached");
}

/** Craft the ballot + the evictee's reads, then run the live eviction to the commit. */
function craft(seed: number, on: boolean) {
  const rel = new RelationshipModel(0.5);
  const s = toEviction(seed, rel, on);
  const p = s as unknown as Priv;
  const ev = p.live.eviction!;
  const [evictee, other] = ev.nominees;
  const pool = p.live.active.filter((id) => id !== PLAYER && id !== p.live.hoh && id !== evictee && id !== other);
  expect(pool.length, "enough voters to craft the ballot").toBeGreaterThanOrEqual(5);
  const [defector, hostileA, hostileB, suspectedKeeper, otherKeeper] = pool;
  // 3 votes to evict (defector + two hostile) vs 2 to keep: the evictee goes. The PUBLIC count is 3.
  ev.voteOf = { [defector!]: evictee, [hostileA!]: evictee, [hostileB!]: evictee, [suspectedKeeper!]: other, [otherKeeper!]: other };
  ev.revealOrder = Object.keys(ev.voteOf);
  ev.revealIx = ev.revealOrder.length; // every ballot already read: the next step tallies and commits
  // The evictee's reads: deeply trusts the true defector; distrusts the two hostile; moderately suspects the keeper who in fact voted to keep them; mildly reads the other keeper.
  const reads: Array<[EntityId, number, number]> = [
    [defector!, 0.9, 0.1], [hostileA!, 0.1, 0.9], [hostileB!, 0.1, 0.9], [suspectedKeeper!, 0.5, 0.5], [otherKeeper!, 0.6, 0.3],
  ];
  const edges = rel.serialize().edges.filter((e) => !(e.from === evictee && reads.some((r) => r[0] === e.to)));
  for (const [to, trust, threat] of reads) edges.push({ from: evictee, to, trust, affinity: 0.5, threat, alignment: 0, confidence: 0.5, reliability: 0.3 });
  rel.load(edges);
  for (let i = 0; i < 20 && !p.live.mannerByEvictee?.[evictee]; i++) s.advanceGame();
  const row = p.live.mannerByEvictee?.[evictee] ?? {};
  return { row, defector: defector!, hostileA: hostileA!, hostileB: hostileB!, suspectedKeeper: suspectedKeeper!, otherKeeper: otherKeeper! };
}

describe("0110 live: the grudge lands on the BELIEVED voter (crafted ballot, true defector not the most suspected)", () => {
  it("deduction ON: the suspected keeper is blamed; the trusted true defector and the unsuspected keeper earn none", () => {
    const r = craft(11, true);
    expect(Object.keys(r.row).length, "positive control: a manner row was recorded").toBeGreaterThan(0);
    expect(r.row[r.hostileA], "hostile voter is believed (and truly voted)").toBeDefined();
    expect(r.row[r.hostileB]).toBeDefined();
    expect(r.row[r.suspectedKeeper], "MISATTRIBUTED: blamed though they voted to keep").toBeDefined();
    expect(r.row[r.defector], "the true secret defector, unsuspected, earns no grudge").toBeUndefined();
    expect(r.row[r.otherKeeper]).toBeUndefined();
  });
  it("control (deduction OFF folds the TRUE ballot): the defector IS blamed and the innocent keeper is not, so the ON test is sensitive to the placement", () => {
    const r = craft(11, false);
    expect(r.row[r.defector]).toBeDefined();
    expect(r.row[r.suspectedKeeper]).toBeUndefined();
  });
});

describe("0110 neutrality with the shipped config (reactive twists ON)", () => {
  const play = (on: boolean) => {
    const s = new GameSessionAdapter();
    s.setReactiveTwistsEnabled(true);
    s.createCharacter({ playerName: "P", seed: 7 });
    s.setVoteDeductionEnabled(on);
    return playSeasonOutcome(s);
  };
  it("the eviction order agrees ON vs OFF (seed 7 agrees over the whole order; if a future twist change diverges late, loosen N to the first evictions, never to nothing)", () => {
    const off = play(false), on = play(true);
    const a = off.evictionOrder as EntityId[], b = on.evictionOrder as EntityId[];
    expect(a.length).toBeGreaterThan(5);
    const N = a.length;
    expect(b.slice(0, N), `first ${N} evictions`).toEqual(a.slice(0, N));
    expect(on.resume, "competition tally").toEqual(off.resume);
  });
});
