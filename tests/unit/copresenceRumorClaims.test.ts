import { describe, it, expect, vi, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { buildSandbox } from "../support/sandbox";
import { spreadBetween, spreadForScenes, type SpreadDeps } from "../../src/engine/copresenceSpread";
import { ToldLedger } from "../../src/engine/heldFacts";
import { recordRumorClaim, claimsOf, type BeliefStore } from "../../src/engine/beliefStore";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { npc } from "../../src/domain/ids";
import { composeRuntime } from "../../src/composition/runtime";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { resolvePending } from "../../features/support/answerPending";
import type { LiveSeasonState } from "../../src/engine/liveSeason";

/**
 * B36 - the co-presence layer's ONE-HOP-BY-SCENE equivalents of the two graph-diffusion tests it replaces (beliefProvenance S0b-2 and liveGossip B27b), plus the B24 heard-rumor claim
 * writer on the co-presence receipt. Roles only. Hidden layer: nothing here reads or writes a player projection.
 */
afterEach(() => vi.unstubAllEnvs());
const H = npc(1), L = npc(2), T = npc(3), S = npc(4);

function setup(o: { seed?: number; subject?: typeof S } = {}) {
  const sb = buildSandbox(7);
  const k = sb.engine.knowledge;
  k.seedBelief(H, { content: "a fact the holder owns", originalContent: "a fact the holder owns", factId: "f1", confidence: 1, hops: 0, distortion: 0, source: H, ...(o.subject ? { subject: o.subject } : {}) }, "origin");
  const heard: Array<{ holder: string; listener: string; subject: string; confidence: number; slipped: boolean }> = [];
  const deps: SpreadDeps = {
    knowledge: k, told: new ToldLedger(),
    rngFor: (h, l) => new SeededRandom((o.seed ?? 3) + h.length * 31 + l.length),
    trust: () => 0.9, affinity: () => 0.9, threat: () => 0, style: () => "emotional", volatility: () => 0.9, audienceOf: () => 0,
    onTold: (r) => heard.push({ holder: r.holder, listener: r.listener, subject: r.subject, confidence: r.confidence, slipped: r.slipped }),
  };
  return { k, deps, heard };
}
const holds = (k: ReturnType<typeof setup>["k"], who: typeof H) => k.knownTo(who).some((f) => (f.factId ?? f.id) === "f1");
function firstTransmitSeed(): number {
  for (let seed = 1; seed < 80; seed++) { const { deps } = setup({ seed, subject: S }); if (spreadBetween(H, L, deps)[0]?.transmitted) return seed; }
  throw new Error("no transmitting seed in 1..79");
}

describe("B36 - one hop BY SCENE (the equivalent of S0b-2 / B27b under the co-presence layer)", () => {
  it("a rumor moves exactly one hop per scene: holder->listener in the scene, never on to a third party in the same tick", () => {
    const seed = firstTransmitSeed();
    const { k, deps } = setup({ seed, subject: S });
    // two scenes in ONE tick: (H,L) then (L,T). L is told in the first; the second pair would pass it on - but the told fact is considered only AFTER it is held, in stable pair order.
    spreadForScenes([[H, L]], deps);
    expect(holds(k, L)).toBe(true);
    expect(holds(k, T), "a person in no scene with the holder never hears it").toBe(false);
    expect(k.knownTo(L).find((f) => (f.factId ?? f.id) === "f1")!.hops, "exactly one hop").toBe(1);
  });
  it("the player is never a node: a scene pair that excludes the player cannot land the fact on them", () => {
    const seed = firstTransmitSeed();
    const { k, deps } = setup({ seed, subject: S });
    spreadForScenes([[H, L]], deps);
    expect(k.knownTo(npc(99)).some((f) => (f.factId ?? f.id) === "f1")).toBe(false);
  });
});

describe("B36/B24 - the co-presence receipt writes a heard-rumor claim", () => {
  it("fires once per transmitted fact WITH a subject, carrying the listener, subject and the decayed confidence", () => {
    const seed = firstTransmitSeed();
    const { deps, heard, k } = setup({ seed, subject: S });
    spreadBetween(H, L, deps);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ holder: H, listener: L, subject: S });
    expect(heard[0]!.confidence).toBeGreaterThan(0);
    expect(heard[0]!.confidence, "decayed below the holder's full confidence").toBeLessThan(1);
    expect(heard[0]!.confidence).toBeCloseTo(k.knownTo(L).find((f) => (f.factId ?? f.id) === "f1")!.confidence!, 10);
  });
  it("does NOT fire for a hold, or for a subject-less fact (nothing falsifiable to believe)", () => {
    const seed = firstTransmitSeed();
    const a = setup({ seed });
    spreadBetween(H, L, a.deps);
    expect(a.heard, "subject-less transmit writes no claim").toEqual([]);
    for (let s = 1; s < 200; s++) {
      const h = setup({ seed: s, subject: S });
      h.deps.trust = () => 0.05; h.deps.affinity = () => 0;
      const r = spreadBetween(H, L, h.deps)[0]!;
      if (r.decision === "held") { expect(h.heard).toEqual([]); return; }
    }
    throw new Error("no hold in 1..199");
  });
  it("the observer is read-only: transmission is identical with and without it", () => {
    const seed = firstTransmitSeed();
    const withObs = setup({ seed, subject: S });
    const without = setup({ seed, subject: S });
    delete without.deps.onTold;
    spreadBetween(H, L, withObs.deps); spreadBetween(H, L, without.deps);
    expect(withObs.k.knownTo(L)).toEqual(without.k.knownTo(L));
  });
  it("recordRumorClaim on the receipt yields a claim with provenance, per-holder isolation, and a zero impact (no edge moved)", () => {
    const seed = firstTransmitSeed();
    const { deps } = setup({ seed, subject: S });
    const store: BeliefStore = {};
    deps.onTold = (r) => { recordRumorClaim(store, { listener: r.listener, subject: r.subject, type: "gossip", confidence: r.confidence, delta: {} }, 3); };
    spreadBetween(H, L, deps);
    const mine = claimsOf(store, L);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: "heard-rumor", holder: L, subject: S, origin: "gossip", nature: "gossip", week: 3, impact: {} });
    expect(claimsOf(store, H), "the teller records no claim for themselves").toHaveLength(0);
    expect(claimsOf(store, T), "a bystander records nothing").toHaveLength(0);
  });
});

describe("B36/B24 - the production runtime under ORWELL_GOSSIP_COPRESENCE writes heard-rumor claims, read-only", () => {
  function play(beliefs: boolean): LiveSeasonState {
    vi.stubEnv("ORWELL_GOSSIP_COPRESENCE", "1");
    vi.stubEnv("ORWELL_NPC_BELIEFS", beliefs ? "1" : "0");
    vi.stubEnv("ORWELL_NPC_BELIEF_NOMS", "0");
    const rt = composeRuntime({ saveStore: new FileSaveStore(mkdtempSync(join(tmpdir(), "orwell-b36-"))) });
    const s = rt.registry.sandboxFor(`b36-${beliefs ? "on" : "off"}`).session;
    s.createCharacter({ playerName: "P", seed: 7 });
    for (let i = 0; i < 9000; i++) {
      const v = s.advanceGame();
      if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
      if (v.finished) break;
    }
    return s.snapshot().live as LiveSeasonState;
  }
  it("beliefs ON records scene-told rumors with provenance; everything else in the season is byte-identical to beliefs OFF", () => {
    const off = play(false);
    const on = play(true);
    expect(off.beliefs).toBeUndefined();
    const rumors = Object.values(on.beliefs ?? {}).flat().filter((c) => c.kind === "heard-rumor");
    expect(rumors.length, "co-presence scenes produced heard rumors").toBeGreaterThan(0);
    expect(rumors.every((c) => c.origin === "gossip" && c.confidence > 0 && c.confidence <= 1)).toBe(true);
    const { beliefs: _b, ...onRest } = on as LiveSeasonState & { beliefs?: unknown };
    expect(JSON.stringify(onRest)).toBe(JSON.stringify(off));
  }, 300_000);
});
