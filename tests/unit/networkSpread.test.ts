import { describe, it, expect } from "vitest";
import { NETWORK, mergeCliques, networkMotive, rolesFromGraph } from "../../src/engine/networkSpread";
import { seekTargets } from "../../src/engine/copresenceSpread";
import { ToldLedger } from "../../src/engine/heldFacts";
import { InMemoryKnowledgeService } from "../../src/adapters/inmemory/InMemoryKnowledgeService";
import { InMemoryEventStore } from "../../src/adapters/inmemory/InMemoryEventStore";
import { deriveHouseGraph, type GraphTie } from "../../src/engine/houseGraph";

/** Feature 0179 - network shape in the spread: the pure motive. Roles only: two cliques (a1-a3, b1-b3), a broker (k) tied into both, a loner (z). */
const mutual = (a: string, b: string, s = 0.9): GraphTie[] => [{ from: a, to: b, strength: s }, { from: b, to: a, strength: s }];
const group = (m: string[]): GraphTie[] => m.flatMap((a, i) => m.slice(i + 1).flatMap((b) => mutual(a, b)));
const ties = [...group(["a1", "a2", "a3"]), ...group(["b1", "b2", "b3"]), ...["a1", "a2", "b1", "b2"].flatMap((o) => mutual("k", o)), ...mutual("z", "a3", 0.3), ...mutual("a3", "b3", 0.3)];
const members = ["a1", "a2", "a3", "b1", "b2", "b3", "k", "z"];
const graph = deriveHouseGraph({ members, ties });
const tieOf = (a: string, b: string) => Math.min(...[ties.find((t) => t.from === a && t.to === b)?.strength ?? 0, ties.find((t) => t.from === b && t.to === a)?.strength ?? 0]);
const roles = rolesFromGraph(graph, tieOf);

describe("network shape in the spread (networkSpread.ts)", () => {
  it("reads the house graph's roles", () => {
    expect(graph.brokers).toContain("k");
    expect(graph.loners).toContain("z");
    expect(roles.cliquesOf("a1").length).toBeGreaterThan(0);
    expect(roles.cliquesOf("z")).toEqual([]);
  });
  it("a broker carrying news about one clique to the other gains motive; inside the subject's clique it gains none", () => {
    expect(networkMotive("k", "b1", "a2", roles)).toBeCloseTo(NETWORK.brokerBridge, 12);
    expect(networkMotive("k", "a1", "a2", roles)).toBe(0);
    expect(networkMotive("a1", "b1", "a2", roles)).toBe(0); // not a broker, and a1-b1 have no casual tie
  });
  it("a casual tie across cliques carries a little more; a close tie inside a clique adds nothing", () => {
    expect(networkMotive("a3", "b3", undefined, roles)).toBeCloseTo(NETWORK.weakTieAcross, 12);
    expect(networkMotive("a1", "a2", undefined, roles)).toBe(0);
  });
  it("a loner is told less", () => {
    expect(networkMotive("a3", "z", undefined, roles)).toBeCloseTo(NETWORK.lonerDamp, 12);
  });
  it("a house with no shape adds nothing - built from the REAL graph of an untied house (which reads everyone as a graph loner)", () => {
    const ids = Array.from({ length: 16 }, (_, i) => `h${i}`);
    const loose = ids.flatMap((a, i) => ids.slice(i + 1).flatMap((b) => mutual(a, b, 0.25)));
    const g = deriveHouseGraph({ members: ids, ties: loose });
    expect(g.loners.length).toBe(16); // the graph's own reading: everyone is a loner
    const r = rolesFromGraph(g, () => 0.25);
    for (const a of ids) for (const b of ids) if (a !== b) expect(networkMotive(a, b, ids[0], r)).toBe(0);
  });
  it("overlapping cliques are read as one group, so 'across' means a real other group", () => {
    expect(mergeCliques([["a", "b", "c"], ["a", "b", "d"], ["x", "y", "z"]])).toEqual([["a", "b", "c", "d"], ["x", "y", "z"]]);
    expect(mergeCliques([["a", "b", "c"], ["c", "d", "e"]])).toEqual([["a", "b", "c"], ["c", "d", "e"]]); // one shared of three: two groups
    const over = [...group(["a1", "a2", "a3"]), ...group(["a1", "a2", "a4"]), ...group(["b1", "b2", "b3"]), ...mutual("a3", "b1", 0.3), ...mutual("a4", "b1", 0.3), ...mutual("a3", "a4", 0.3)];
    const g = deriveHouseGraph({ members: ["a1", "a2", "a3", "a4", "b1", "b2", "b3"], ties: over });
    expect(g.cliques.length).toBe(3);
    const t = (a: string, b: string) => Math.min(over.find((x) => x.from === a && x.to === b)?.strength ?? 0, over.find((x) => x.from === b && x.to === a)?.strength ?? 0);
    const r = rolesFromGraph(g, t);
    expect(networkMotive("a3", "a4", undefined, r)).toBe(0); // casually tied, in two overlapping cliques: one group, so not "across"
    expect(networkMotive("a3", "b1", undefined, r)).toBeCloseTo(NETWORK.weakTieAcross, 12);
  });
  it("the broker bonus needs the broker tied into both the subject's group and the listener's", () => {
    // c is tied into groups A and B but not C: news about A told to someone in C is not a bridge the broker spans
    const t3 = [...group(["a1", "a2", "a3"]), ...group(["b1", "b2", "b3"]), ...group(["c1", "c2", "c3"]), ...["a1", "a2", "b1", "b2"].flatMap((o) => mutual("k", o))];
    const g = deriveHouseGraph({ members: ["a1", "a2", "a3", "b1", "b2", "b3", "c1", "c2", "c3", "k"], ties: t3 });
    const t = (a: string, b: string) => Math.min(t3.find((x) => x.from === a && x.to === b)?.strength ?? 0, t3.find((x) => x.from === b && x.to === a)?.strength ?? 0);
    const r = rolesFromGraph(g, t);
    expect(r.isBroker("k")).toBe(true);
    expect(networkMotive("k", "b3", "a3", r)).toBeCloseTo(NETWORK.brokerBridge, 12);
    expect(networkMotive("k", "c1", "a3", r)).toBe(0);
  });
  it("the shape draws movement: a broker with news about one group is drawn harder toward the other group", () => {
    const knowledge = new InMemoryKnowledgeService(new InMemoryEventStore());
    knowledge.seedBelief("k", { content: "news", factId: "f1", subject: "a3", confidence: 0.8, hops: 0, distortion: 0, source: "k" }, "witnessed");
    const base = { knowledge, told: new ToldLedger(), affinity: () => 0.4, threat: () => 0.2 };
    const flat = seekTargets("k", ["b3"], base)[0]!.motive;
    const shaped = seekTargets("k", ["b3"], { ...base, network: roles })[0]!.motive;
    expect(shaped).toBeCloseTo(flat + NETWORK.brokerBridge, 12);
  });
});
