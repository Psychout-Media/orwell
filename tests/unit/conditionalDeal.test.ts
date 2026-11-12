import { describe, it, expect } from "vitest";
import { DealLedger, type ReconcileSink } from "../../src/engine/deals";
import { RelationshipModel } from "../../src/engine/relationships";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { npc } from "../../src/domain/ids";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { conditionFor, actionBreaks, actionHonors, horizonOf, type Deal } from "../../src/domain/deal";
import type { DealView } from "../../src/ports/GameSession";

/**
 * ORW-88 / 0142 idea 3 (conditional): a mutual "if either of us is on the block at the vote, the other votes to keep them". It binds only at the VOTE: nominating the partner is not a break,
 * evicting them is; a week with no such vote lapses without a break. Played games with deal depth on only. Roles only.
 */
const mk = (): Deal => ({ id: "d", status: "open", kind: "conditional", terms: "t", parties: ["npc:a", "npc:b"], condition: conditionFor("conditional", ["npc:a", "npc:b"]) }) as Deal;

describe("the pure rule", () => {
  it("is week-scoped and mutual", () => {
    expect(horizonOf("conditional")).toBe("week");
    expect(mk().condition.promisors).toEqual(["npc:a", "npc:b"]);
  });
  it("nominating or replacing the partner is NOT a break; voting them out is, for either party", () => {
    const d = mk();
    expect(actionBreaks(d, { actor: "npc:a", kind: "nominate", targets: ["npc:b"] })).toBe(false);
    expect(actionBreaks(d, { actor: "npc:a", kind: "replace", targets: ["npc:b"] })).toBe(false);
    expect(actionBreaks(d, { actor: "npc:a", kind: "vote-evict", targets: ["npc:b"] })).toBe(true);
    expect(actionBreaks(d, { actor: "npc:b", kind: "vote-evict", targets: ["npc:a"] })).toBe(true);
    expect(actionBreaks(d, { actor: "npc:a", kind: "vote-evict", targets: ["npc:c"] })).toBe(false);
  });
  it("only a vote that spares the partner (a real alternative) honors it", () => {
    const d = mk();
    expect(actionHonors(d, { actor: "npc:a", kind: "vote-evict", targets: ["npc:c"], alternatives: ["npc:b", "npc:c"] })).toBe(true);
    expect(actionHonors(d, { actor: "npc:a", kind: "nominate", targets: ["npc:c"], alternatives: ["npc:b", "npc:c"] })).toBe(false);
    expect(actionHonors(d, { actor: "npc:a", kind: "vote-evict", targets: ["npc:c"], alternatives: ["npc:c", "npc:d"] })).toBe(false); // the partner was never on the block
  });
});

describe("expiry is neutral when the promise was never tested (coordinator ruling on #2405)", () => {
  const A = npc(1), B = npc(2), C = npc(3);
  const snap = (rel: RelationshipModel) => JSON.stringify([rel.edge(A, B), rel.edge(B, A)]);
  const sinkFor = (rel: RelationshipModel): ReconcileSink => ({ rel, rng: new SeededRandom(7), dealDepth: true, reputation: () => { reps.n++; } });
  const reps = { n: 0 };

  it("an untested conditional expires: not kept, no reliability / reputation change for either party, no longer binding", () => {
    const rel = new RelationshipModel(0.5), ledger = new DealLedger();
    reps.n = 0;
    const d = ledger.make([A, B], "conditional", "keep each other if on the block", undefined, 1);
    const before = snap(rel);
    expect(ledger.expireWeekScoped(2)).toEqual([]); // nothing resolved "kept"
    expect(d.status).not.toBe("kept");
    expect(ledger.forParty(A)).toHaveLength(0);
    expect(ledger.open()).toHaveLength(0);
    expect(snap(rel)).toBe(before);
    expect(reps.n).toBe(0);
    // a later vote against the former partner is no betrayal: the pact is gone
    ledger.reconcile({ actor: A, kind: "vote-evict", targets: [B] }, sinkFor(rel));
    expect(snap(rel)).toBe(before);
  });
  it("a tested one still credits: the vote that spares the partner resolves it kept and builds reliability", () => {
    const rel = new RelationshipModel(0.5), ledger = new DealLedger();
    reps.n = 0;
    const d = ledger.make([A, B], "conditional", "keep each other if on the block", undefined, 1);
    const before = snap(rel);
    const out = ledger.reconcile({ actor: A, kind: "vote-evict", targets: [C], alternatives: [B, C] }, sinkFor(rel));
    expect(out.kept).toContain(d);
    expect(d.status).toBe("kept");
    expect(snap(rel)).not.toBe(before);
    expect(reps.n).toBeGreaterThan(0);
  });
  it("other week-scoped kinds still resolve kept on expiry (unchanged)", () => {
    const ledger = new DealLedger();
    const v = ledger.make([A, B], "vote", "a vote", undefined, 1);
    expect(ledger.expireWeekScoped(2)).toEqual([v]);
    expect(v.status).toBe("kept");
  });
});

describe("making it", () => {
  type Internals = { live: { playedGame?: boolean }; setNpcDealConsentEnabled(on: boolean): void; setDealDepthEnabled(on: boolean): void; rel: { edge(a: string, b: string): { trust: number; affinity: number; threat: number } } };
  function game(played = true, depth = true) {
    const sb = new GameSessionRegistry().sandboxFor(`cond-${Math.random()}`);
    sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
    sb.session.advanceGame(); sb.session.advanceGame();
    const g = sb.session as unknown as Internals;
    g.setNpcDealConsentEnabled(true); g.setDealDepthEnabled(depth); g.live.playedGame = played;
    const npc = [...sb.session.livingIds()].find((i) => i !== PLAYER)!;
    const e = g.rel.edge(npc, PLAYER); e.trust = 0.7; e.affinity = 0.7; e.threat = 0.1;
    return { s: sb.session, npc };
  }
  const ask = (x: ReturnType<typeof game>) => x.s.makeDeal({ with: x.npc, kind: "conditional", terms: "keep each other if on the block" } as never);
  it("a willing NPC makes it in a played game with deal depth on", () => {
    const x = game();
    expect((ask(x) as DealView).kind).toBe("conditional");
  });
  it("is refused (null) when nobody is playing or deal depth is off", () => {
    expect(ask(game(false))).toBeNull();
    expect(ask(game(true, false))).toBeNull();
  });
});
