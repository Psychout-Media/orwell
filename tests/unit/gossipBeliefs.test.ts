import { describe, it, expect, vi, afterEach } from "vitest";
import { testTmpDir } from "../support/freshTmpDir";
import { composeRuntime } from "../../src/composition/runtime";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { npc, PLAYER } from "../../src/domain/ids";
import { recordRumorClaim, claimsOf, refuteClaim, type BeliefStore, type BeliefClaim } from "../../src/engine/beliefStore";
import { BELIEF_PULL, beliefPull, believedGrievance, believedGrievances, grievanceOf } from "../../src/engine/beliefDecisions";
import { THREAT_NATURES, natureFromContent, gossipConviction } from "../../src/engine/gossipBeliefs";
import { rumorFrom } from "../../src/engine/gossip";
import { FEATURE_FLAGS } from "../../src/featureFlags";
import type { LiveSeasonState } from "../../src/engine/liveSeason";

/**
 * Feature 0169 / ORW-546 - off-screen gossip feeds beliefs. Roles only: L = the listener, T = the teller, S = the subject of the rumor.
 */
afterEach(() => vi.unstubAllEnvs());
const L = npc(1), T = npc(2), S = npc(3);
const rumor = (o: Partial<BeliefClaim> = {}): BeliefClaim => ({ id: "c", holder: L, kind: "heard-rumor", subject: S, value: true, origin: "gossip", nature: "betrayal", source: T, confidence: 0.8, week: 1, ...o });

describe("0169 - the rumor reads as a soft grievance in decisions", () => {
  it("a told betrayal / conflict / strategy rumor is a rumored-threat; an alliance, a bare (teller-less) or a refuted one is not", () => {
    for (const nature of THREAT_NATURES) expect(grievanceOf(rumor({ nature }), L)).toBe("rumored-threat");
    expect(grievanceOf(rumor({ nature: "alliance" }), L), "an alliance is not a threat").toBeUndefined();
    expect(grievanceOf(rumor({ source: undefined }), L), "a teller-less (flag-off) rumor never counts - byte-identical off").toBeUndefined();
    expect(grievanceOf(rumor({ refuted: true }), L)).toBeUndefined();
    expect(grievanceOf(rumor({ origin: "told" }), L), "the heard-about-me rumor is not off-screen gossip").toBeUndefined();
  });
  it("is proportional to conviction: a trusted teller pulls harder than a doubted one, and a refuted rumor counts for nothing", () => {
    const pull = (confidence: number, extra: Partial<BeliefClaim> = {}) => beliefPull({ [L]: [rumor({ confidence, ...extra })] }, L, S, 1);
    expect(pull(0.8)).toBeGreaterThan(pull(0.4));
    expect(pull(0.4)).toBeGreaterThan(pull(0.1));
    expect(pull(0.8, { refuted: true })).toBe(0);
  });
  it("is soft: alone it cannot form a revenge goal, however sure; the kind weight is below the revenge bar", () => {
    expect(BELIEF_PULL.kindWeight["rumored-threat"]).toBe(0.35);
    const store: BeliefStore = { [L]: [rumor({ confidence: 1 })] };
    expect(believedGrievance(store, L, S, 1).strength).toBeLessThan(BELIEF_PULL.revengeBar);
    expect(believedGrievances(store, L, [S], 1)).toEqual([]);
  });
  it("fades with the weeks like every other belief", () => {
    const store: BeliefStore = { [L]: [rumor()] };
    expect(believedGrievance(store, L, S, 9).strength).toBeLessThan(believedGrievance(store, L, S, 1).strength);
  });
});

describe("0169 - conviction from the teller", () => {
  it("rises with trust in the teller and with the listener's credulity; stays in 0..1", () => {
    expect(gossipConviction(0.9, false, 0.5)).toBeGreaterThan(gossipConviction(0.1, false, 0.5));
    expect(gossipConviction(0.5, false, 0.9)).toBeGreaterThan(gossipConviction(0.5, false, 0.1));
    expect(gossipConviction(0.5, true, 0.5)).toBeGreaterThan(gossipConviction(0.5, false, 0.5));
    for (const t of [0, 0.5, 1]) for (const c of [0, 0.5, 1]) { const v = gossipConviction(t, false, c); expect(v >= 0 && v <= 1).toBe(true); }
  });
  it("reads a rumor's nature back from its text", () => {
    expect(natureFromContent(rumorFrom(S, T, "betrayal"))).toBe("betrayal");
    expect(natureFromContent(rumorFrom(S, T, "alliance"))).toBe("alliance");
    expect(natureFromContent("something unrelated")).toBeUndefined();
  });
  it("recordRumorClaim keeps the teller when given one, and nothing extra when not", () => {
    const a: BeliefStore = {}, b: BeliefStore = {};
    recordRumorClaim(a, { listener: L, subject: S, type: "betrayal", confidence: 0.5, delta: {}, source: T }, 1);
    recordRumorClaim(b, { listener: L, subject: S, type: "betrayal", confidence: 0.5, delta: {} }, 1);
    expect(claimsOf(a, L)[0]!.source).toBe(T);
    expect("source" in claimsOf(b, L)[0]!).toBe(false);
  });
});

function session(flag: "0" | "1") {
  vi.stubEnv("ORWELL_GOSSIP_BELIEFS", flag);
  vi.stubEnv("ORWELL_NPC_BELIEFS", "1");
  const rt = composeRuntime({ saveStore: new FileSaveStore(testTmpDir("orwell-0169-")) });
  const sb = rt.registry.sandboxFor(`g-${flag}`);
  sb.session.createCharacter({ playerName: "P", seed: 11 });
  sb.session.advanceGame();
  const ids = sb.session.snapshot().house!.npcs.map((n) => n.id);
  return { s: sb.session as any, ids, live: () => sb.session.snapshot().live as LiveSeasonState };
}

describe("0169 - the live observer (the shipped wiring)", () => {
  it("flag ON: a heard rumor carries its teller and a conviction driven by trust in the teller", () => {
    const { s, ids, live } = session("1");
    const [l, t, sub] = ids as [string, string, string];
    const edge = (s as any).rel.edge(l, t);
    const obs = s.beliefReceiptObserver();
    edge.trust = 0.95; obs({ listener: l, subject: sub, type: "betrayal", confidence: 0.9, delta: {}, source: t, factId: "f1", unfolded: true });
    edge.trust = 0.05; obs({ listener: l, subject: npc(77), type: "betrayal", confidence: 0.9, delta: {}, source: t, factId: "f2", unfolded: true });
    const mine = claimsOf(live().beliefs, l).filter((c) => c.kind === "heard-rumor");
    const hi = mine.find((c) => c.subject === sub)!, lo = mine.find((c) => c.subject === npc(77))!;
    expect(hi.source).toBe(t);
    expect(hi.confidence).toBeGreaterThan(lo.confidence);
  });
  it("flag ON: a co-presence receipt (nothing folded) moves the listener's feelings in proportion to conviction, and a refutation takes half back", () => {
    const { s, ids, live } = session("1");
    const [l, t, sub] = ids as [string, string, string];
    const rel = (s as any).rel;
    rel.edge(l, t).trust = 0.95;
    const before = rel.edge(l, sub).trust;
    s.beliefReceiptObserver()({ listener: l, subject: sub, type: "betrayal", confidence: 0.9, delta: {}, source: t, factId: "f1", unfolded: true });
    const after = rel.edge(l, sub).trust;
    expect(after).toBeLessThan(before);
    const c = claimsOf(live().beliefs, l).find((x) => x.kind === "heard-rumor")!;
    expect(c.impact?.trust, "the fold is recorded so it can be refuted").toBeLessThan(0);
    const back = refuteClaim(live().beliefs!, l, c.id, (h, o) => rel.edge(h, o));
    expect(back.trust).toBeLessThan(0 + 1e-9);
    expect(rel.edge(l, sub).trust).toBeGreaterThan(after);
  });
  it("flag ON: the fold uses a stream of its own - the same receipt twice from the same state lands identically (no shared-rng draw)", () => {
    const a = session("1"), b = session("1");
    for (const x of [a, b]) { const [l, t, sub] = x.ids as [string, string, string]; x.s.rel.edge(l, t).trust = 0.7; x.s.beliefReceiptObserver()({ listener: l, subject: sub, type: "strategy", confidence: 0.9, delta: {}, source: t, factId: "f", unfolded: true }); }
    const [l, , sub] = a.ids as [string, string, string];
    expect(a.s.rel.edge(l, sub)).toEqual(b.s.rel.edge(l, sub));
  });
  it("flag OFF (kill switch): the observer is today's - confidence as transmitted, no teller, no extra fold", () => {
    const { s, ids, live } = session("0");
    const [l, t, sub] = ids as [string, string, string];
    const before = { ...s.rel.edge(l, sub) };
    s.beliefReceiptObserver()({ listener: l, subject: sub, type: "betrayal", confidence: 0.42, delta: {}, source: t, factId: "f1", unfolded: true });
    const c = claimsOf(live().beliefs, l).find((x) => x.kind === "heard-rumor")!;
    expect(c.confidence).toBe(0.42);
    expect(c.source, "flag off: the rumor keeps no teller, so no decision counts it").toBeUndefined();
    expect(grievanceOf(c, l), "OFF is byte-identical in decisions only if the record is teller-less").toBeUndefined();
    expect(s.rel.edge(l, sub)).toEqual(before);
  });
  it("is a registered default-on flag", () => {
    const f = FEATURE_FLAGS.find((x) => x.envKey === "ORWELL_GOSSIP_BELIEFS");
    expect(f?.parser).toBe("defaultOn");
  });
});
