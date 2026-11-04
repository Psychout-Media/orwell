import { describe, it, expect } from "vitest";
import { makeSocialGraph, diffuseGossip, rumorFrom } from "../../src/engine/gossip";
import { RelationshipModel } from "../../src/engine/relationships";
import { buildEngineCore } from "../../src/composition/engineRoot";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { npc } from "../../src/domain/ids";
import { recordRumorClaim, refuteClaim, claimsOf, edgeDelta, REFUTE_REVERSAL_FRACTION, type BeliefStore, type EdgeDelta } from "../../src/engine/beliefStore";

/**
 * #2017 S0b-1 — claim PROVENANCE + REFUTABILITY over what the edge update already absorbed. Gates: (1) the receipt observer is READ-ONLY (same edges,
 * same parent rng tail with and without it); (2) the recorded impact IS the delta the fold applied; (3) a refutation takes back a BOUNDED FRACTION as a
 * delta on the CURRENT edge (later events kept), clamped, idempotent; unknown/impact-less is a no-op. Roles only.
 */
const SEED = 7;
const A = npc(1), B = npc(2);
const graph = () => makeSocialGraph([[npc(10), npc(11)], [npc(11), npc(12)], [npc(12), npc(13)], [npc(13), npc(14)], [npc(11), npc(15)]]);

function run(observe: boolean): { edges: Record<string, number[]>; tail: number[]; received: { listener: string; subject: string; delta: EdgeDelta; type: string; confidence: number }[] } {
  const rng = new SeededRandom(SEED);
  const rel = new RelationshipModel(0.5);
  const received: { listener: string; subject: string; delta: EdgeDelta; type: string; confidence: number }[] = [];
  diffuseGossip({
    knowledge: buildEngineCore().knowledge, graph: graph(), rng, origin: npc(10),
    fact: { content: rumorFrom(A, B, "betrayal") }, rounds: 5, transmitProb: 1, decay: 0.7,
    rel, subjects: [A, B], sceneType: "betrayal",
    ...(observe ? { onReceipt: (r: (typeof received)[number]) => { received.push(r); } } : {}),
  });
  const edges: Record<string, number[]> = {};
  for (const l of [11, 12, 13, 14, 15]) for (const s of [A, B]) { const e = rel.edge(npc(l), s); edges[`${l}>${s}`] = [e.trust, e.affinity, e.threat]; }
  return { edges, tail: Array.from({ length: 64 }, () => rng.next()), received };
}

describe("the gossip receipt observer is read-only", () => {
  it("edges and the parent rng tail are byte-identical with and without it", () => {
    const off = run(false), on = run(true);
    expect(on.edges).toEqual(off.edges);
    expect(on.tail).toEqual(off.tail);
    expect(on.received.length, "non-vacuous: receipts were observed").toBeGreaterThan(0);
  });
  it("the observed delta equals the edge move the fold actually made", () => {
    const rng = new SeededRandom(SEED);
    const rel = new RelationshipModel(0.5);
    const seen: { listener: string; subject: string; delta: EdgeDelta }[] = [];
    diffuseGossip({
      knowledge: buildEngineCore().knowledge, graph: graph(), rng, origin: npc(10), fact: { content: rumorFrom(A, B, "betrayal") },
      rounds: 5, transmitProb: 1, rel, subjects: [A, B], sceneType: "betrayal", onReceipt: (r) => { seen.push(r); },
    });
    expect(seen.length).toBeGreaterThan(0);
    const sum: Record<string, number[]> = {};
    for (const r of seen) { const k = `${r.listener}>${r.subject}`; const v = (sum[k] ??= [0, 0, 0]); v[0] += r.delta.trust ?? 0; v[1] += r.delta.affinity ?? 0; v[2] += r.delta.threat ?? 0; }
    const baseline = new RelationshipModel(0.5);
    for (const [k, v] of Object.entries(sum)) {
      const [l, s] = k.split(">") as [string, string];
      const b = baseline.edge(l, s); const e = rel.edge(l, s);
      expect([e.trust - b.trust, e.affinity - b.affinity, e.threat - b.threat].map((x) => +x.toFixed(9))).toEqual(v.map((x) => +x.toFixed(9)));
    }
  });
});

describe("refuting a claim", () => {
  const mk = () => {
    const rel = new RelationshipModel(0.5);
    const store: BeliefStore = {};
    const e = rel.edge(npc(11), A);
    const before = { trust: e.trust, affinity: e.affinity, threat: e.threat };
    e.trust -= 0.2; e.threat += 0.3;                       // the rumor moved the edge
    recordRumorClaim(store, { listener: npc(11), subject: A, type: "betrayal", confidence: 0.7, delta: edgeDelta(before, e) }, 2);
    const stored = claimsOf(store, npc(11))[0]!;
    expect(stored.kind).toBe("heard-rumor");
    expect(stored.origin).toBe("gossip");
    expect(stored.nature).toBe("betrayal");
    expect(stored.impact).toEqual({ trust: expect.closeTo(-0.2, 9), threat: expect.closeTo(0.3, 9) });
    return { rel, store, id: stored.id, before };
  };
  it("takes back a bounded fraction as a delta on the CURRENT edge (a later event is kept)", () => {
    const { rel, store, id, before } = mk();
    rel.edge(npc(11), A).trust += 0.1;                     // a LATER, unrelated move on the same edge
    const back = refuteClaim(store, npc(11), id, (h, s) => rel.edge(h, s));
    const e = rel.edge(npc(11), A);
    expect(back.trust).toBeCloseTo(-0.2 * REFUTE_REVERSAL_FRACTION, 9);
    expect(back.threat).toBeCloseTo(0.3 * REFUTE_REVERSAL_FRACTION, 9);
    expect(e.trust).toBeCloseTo(before.trust - 0.2 + 0.1 + 0.2 * REFUTE_REVERSAL_FRACTION, 9);   // not a snapshot restore: the later +0.1 survives
    expect(e.trust, "never past where it started").toBeLessThan(before.trust + 0.1 + 1e-9);
    expect(claimsOf(store, npc(11))[0]!.refuted).toBe(true);
  });
  it("is idempotent; unknown ids and impact-less claims change nothing", () => {
    const { rel, store, id } = mk();
    const first = refuteClaim(store, npc(11), id, (h, s) => rel.edge(h, s));
    const snap = JSON.stringify(rel.edge(npc(11), A));
    expect(refuteClaim(store, npc(11), id, (h, s) => rel.edge(h, s))).toEqual({});
    expect(refuteClaim(store, npc(11), "nope", (h, s) => rel.edge(h, s))).toEqual({});
    expect(JSON.stringify(rel.edge(npc(11), A))).toBe(snap);
    expect(first.trust).toBeDefined();
    const bare: BeliefStore = {};
    recordRumorClaim(bare, { listener: npc(12), subject: A, type: "gossip", confidence: 0.5, delta: {} }, 1);
    const claimsBefore = JSON.stringify(bare), edgeBefore = JSON.stringify(rel.edge(npc(12), A));
    expect(refuteClaim(bare, npc(12), claimsOf(bare, npc(12))[0]!.id, (h, s) => rel.edge(h, s))).toEqual({});
    expect(JSON.stringify(bare), "an impact-less claim is left exactly as it was (not marked refuted)").toBe(claimsBefore);
    expect(JSON.stringify(rel.edge(npc(12), A))).toBe(edgeBefore);
  });
  it("clamps to [0,1]", () => {
    const rel = new RelationshipModel(0.5);
    const store: BeliefStore = {};
    rel.edge(npc(13), A).threat = 0.05;
    recordRumorClaim(store, { listener: npc(13), subject: A, type: "betrayal", confidence: 1, delta: { threat: 0.4 } }, 1);
    refuteClaim(store, npc(13), claimsOf(store, npc(13))[0]!.id, (h, s) => rel.edge(h, s));
    expect(rel.edge(npc(13), A).threat).toBe(0);
    // and the upper bound: a NEGATIVE recorded impact near 1 clamps to 1
    rel.edge(npc(14), A).trust = 0.98;
    recordRumorClaim(store, { listener: npc(14), subject: A, type: "gossip", confidence: 1, delta: { trust: -0.6 } }, 1);
    refuteClaim(store, npc(14), claimsOf(store, npc(14))[0]!.id, (h, s) => rel.edge(h, s));
    expect(rel.edge(npc(14), A).trust).toBe(1);
  });
  it("repeated receipts for one holder/subject/week keep separate provenance and separate refutation", () => {
    const rel = new RelationshipModel(0.5);
    const store: BeliefStore = {};
    recordRumorClaim(store, { listener: npc(15), subject: A, type: "betrayal", confidence: 0.4, delta: { threat: 0.1 } }, 3);
    recordRumorClaim(store, { listener: npc(15), subject: A, type: "betrayal", confidence: 0.9, delta: { threat: 0.2 } }, 3);
    const cs = claimsOf(store, npc(15));
    expect(cs).toHaveLength(2);
    expect(cs.map((c) => c.impact!.threat)).toEqual([0.1, 0.2]);
    rel.edge(npc(15), A).threat = 0.5;
    refuteClaim(store, npc(15), cs[0]!.id, (h, s) => rel.edge(h, s));
    expect(cs[0]!.refuted).toBe(true);
    expect(cs[1]!.refuted, "the other receipt is untouched").toBeUndefined();
  });
  it("a caller can narrow the reversal but never widen it past the bound", () => {
    const rel = new RelationshipModel(0.5);
    const store: BeliefStore = {};
    rel.edge(npc(16), A).threat = 0.8;
    recordRumorClaim(store, { listener: npc(16), subject: A, type: "betrayal", confidence: 1, delta: { threat: 0.4 } }, 1);
    const back = refuteClaim(store, npc(16), claimsOf(store, npc(16))[0]!.id, (h, s) => rel.edge(h, s), 5);
    expect(back.threat).toBeCloseTo(0.4 * REFUTE_REVERSAL_FRACTION, 9);
  });
});

// ── S0b-2: wired through the PRODUCTION runtime's off-screen gossip (the orchestrator tick) ──
import { vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeRuntime } from "../../src/composition/runtime";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { resolvePending } from "../../features/support/answerPending";
import type { LiveSeasonState } from "../../src/engine/liveSeason";

afterEach(() => vi.unstubAllEnvs());

function playThroughRuntime(on: boolean, seed: number): LiveSeasonState {
  vi.stubEnv("ORWELL_NPC_BELIEFS", on ? "1" : "0");
  vi.stubEnv("ORWELL_NPC_BELIEF_NOMS", "0"); // the claim OBSERVER must be read-only; the nomination/vote TERM (default ON since P4f) legitimately moves outcomes and is covered by beliefNoms/beliefVoteTilt
  const rt = composeRuntime({ saveStore: new FileSaveStore(mkdtempSync(join(tmpdir(), "orwell-s0b2-"))) });
  const s = rt.registry.sandboxFor(`s0b2-${seed}`).session;
  s.createCharacter({ playerName: "P", seed });
  for (let i = 0; i < 9000; i++) {
    const v = s.advanceGame();
    if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
    if (v.finished) break;
  }
  return s.snapshot().live as LiveSeasonState;
}

describe("S0b-2: the off-screen gossip tick records heard-rumor claims (flag-gated, read-only)", () => {
  it("OFF: no store; ON: rumor claims with provenance — and everything else in the season state is byte-identical", () => {
    const off = playThroughRuntime(false, 7);
    const on = playThroughRuntime(true, 7);
    expect(off.beliefs).toBeUndefined();
    const rumors = Object.values(on.beliefs ?? {}).flat().filter((c) => c.kind === "heard-rumor");
    expect(rumors.length, "the off-screen society produced heard rumors").toBeGreaterThan(0);
    expect(rumors.every((c) => c.origin === "gossip" && typeof c.nature === "string" && c.impact !== undefined && c.confidence > 0 && c.confidence <= 1)).toBe(true);
    const { beliefs: _b, ...onRest } = on as LiveSeasonState & { beliefs?: unknown };
    const sha = (x: unknown): string => createHash("sha256").update(JSON.stringify(x)).digest("hex");
    expect(sha(onRest), "the gossip observer moved nothing: season state is byte-identical off vs on").toBe(sha(off));
  }, 300_000);
});
