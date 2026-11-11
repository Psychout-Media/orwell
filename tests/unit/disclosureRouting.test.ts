import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import { routeDisclosure, routeConfide, type RouteCtx } from "../../src/engine/disclosureRoute";
import { disclosureOdds } from "../../src/engine/disclosure";
import { decideConfidence, type ConfidenceSignals } from "../../src/engine/confidence";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import type { RelationshipModel } from "../../src/engine/relationships";
import type { GameHouse } from "../../src/engine/characterFactory";

/**
 * B33 / D1 - confide and the 0092 drip decide through `disclosureDecision`. Roles only. Pure routing: monotone distributions by personality x relationship x audience, one decision per press however it
 * is worded; played-game session: the engine's record is the only source of a confession, a held press hands over nothing, and no sealed text reaches the record.
 */
const sig = (w: number): ConfidenceSignals => ({ npcTrust: w, npcAffinity: w, npcThreat: 0.1, playerTrust: w, playerAffinity: w, goodwill: w, archetype: "floater" });
const ctx = (over: Partial<RouteCtx> = {}): RouteCtx => ({ signals: sig(0.6), audience: 0, pressure: 1, risk: 0.3, roll: 0.5, ...over });
const rate = (over: Partial<RouteCtx>, n = 400): { share: number; slip: number } => {
  const rng = new SeededRandom(99);
  let share = 0, slip = 0;
  for (let i = 0; i < n; i++) { const d = routeDisclosure(ctx({ ...over, roll: rng.next() })); if (d === "share") share++; else if (d === "slip") slip++; }
  return { share: share / n, slip: slip / n };
};

describe("routing distributions (seeded, monotone)", () => {
  it("relationship: more warmth never lowers the share rate", () => {
    let prev = -1;
    for (const w of [0.1, 0.3, 0.5, 0.7, 0.9]) { const r = rate({ signals: sig(w) }).share; expect(r).toBeGreaterThanOrEqual(prev - 0.02); prev = r; }
    expect(rate({ signals: sig(0.9) }).share).toBeGreaterThan(rate({ signals: sig(0.1) }).share);
  });
  it("audience: a bigger crowd never raises the share rate", () => {
    let prev = 2;
    for (const a of [0, 1, 2, 3, 5]) { const r = rate({ audience: a }).share; expect(r).toBeLessThanOrEqual(prev + 0.02); prev = r; }
    expect(rate({ audience: 5 }).share).toBeLessThan(rate({ audience: 0 }).share);
  });
  it("personality: a leakier holder slips at least as often, volatility raises it too", () => {
    const r = (style: "loyal" | "emotional") => rate({ style }).slip;
    expect(r("emotional")).toBeGreaterThan(r("loyal"));
    expect(rate({ volatility: 0.9 }).slip).toBeGreaterThanOrEqual(rate({ volatility: 0.1 }).slip);
  });
  it("odds are bounded: nothing is certain, and slip never exceeds its cap", () => {
    const o = disclosureOdds({ motive: 1, holderTrustsListener: 1, listenerTrustsHolder: 1, risk: 0, audience: 0, leakiness: 1, cunning: 0, rattled: 1, pressure: 1 });
    expect(o.share).toBeLessThanOrEqual(0.85); expect(o.slip).toBeLessThanOrEqual(0.3);
  });
});

describe("wording invariance", () => {
  it("six phrasings of the same press are one decision: the lever takes no wording, so equal recorded inputs and the same side-stream draw give the same routed result", () => {
    const run = () => routeConfide(decideConfidence(sig(0.7), new SeededRandom(3), { liesRemaining: 2 }), routeDisclosure(ctx({ signals: sig(0.7), roll: new SeededRandom(8).next() })));
    const ds = Array.from({ length: 6 }, run);
    for (const d of ds) expect(d).toEqual(ds[0]);
  });
});

describe("through the real session (played game)", () => {
  const SENTINEL = "SEALED-SENTINEL-7f3a-detail";
  function started(played: boolean) {
    const session = new GameSessionAdapter();
    const confided: string[] = [];
    session.setOnConfide((_n, content) => { confided.push(content); return true; });
    session.createCharacter({ playerName: "The Player", seed: 7 });
    const house = (session as unknown as { house: GameHouse }).house;
    const npc = house.npcs.find((n) => (n.character.hiddenElements ?? []).length > 0)!;
    npc.character.hiddenElements![0]!.detail = SENTINEL;
    const presence = (session as unknown as { presence?: Map<string, string> }).presence;
    if (presence) { presence.set(PLAYER, "kitchen"); presence.set(npc.id, "kitchen"); }
    const rel = (session as unknown as { rel: RelationshipModel }).rel;
    for (const [a, b] of [[npc.id, PLAYER], [PLAYER, npc.id]] as const) { const e = rel.edge(a, b); e.trust = 0.9; e.affinity = 0.9; e.threat = 0.05; }
    for (let i = 0; i < 3; i++) session.makeDeal({ with: npc.id, kind: "final-two", terms: "ride or die" });
    if (played) session.noteMessage({ messageId: "first" });
    return { session, npc: npc.id, confided };
  }
  it("a played press gets ONE closed-set decision per beat however often it is pressed; a held press hands over nothing and records no confession", () => {
    const { session, npc, confided } = started(true);
    const first = session.confide(npc)!;
    const ev = session.disclosureThisBeat(npc);
    for (let i = 0; i < 5; i++) {
      const again = session.confide(npc)!;
      expect(again.disclosed).toBe(first.disclosed);
      expect(session.disclosureThisBeat(npc)?.outcome).toBe(ev?.outcome);
    }
    if (!first.disclosed) {
      expect(ev).toMatchObject({ outcome: "deflect" });
      expect(confided).toHaveLength(0); // hallucinated-confession guard: no told-by fact exists for a press the engine held
      expect(first.content).toBeUndefined();
    } else {
      expect(["confirm", "slip"]).toContain(ev!.outcome);
      expect(confided.length).toBeGreaterThan(0);
    }
  });
  it("hallucinated-confession guard: with no press this beat the engine has recorded no disclosure at all", () => {
    const { session, npc, confided } = started(true);
    expect(session.disclosureThisBeat(npc)).toBeUndefined();
    expect(confided).toHaveLength(0);
  });
  it("Vault sentinel: the sealed detail never appears in the disclosure record, and a sub-full tier never carries it", () => {
    const { session, npc } = started(true);
    const r = session.confide(npc)!;
    expect(JSON.stringify(session.disclosureThisBeat(npc) ?? {})).not.toContain(SENTINEL);
    if (r.disclosed && r.tier !== "full") expect(r.content ?? "").not.toContain(SENTINEL);
    if (!r.disclosed) expect(JSON.stringify(r)).not.toContain(SENTINEL);
  });
  it("before the first announced message the old decision stands (unrouted)", () => {
    const { session, npc } = started(false);
    const r = session.confide(npc)!;
    expect(r.disclosed).toBe(true);
    expect(session.disclosureThisBeat(npc)).toMatchObject({ outcome: "confirm" });
  });
});
