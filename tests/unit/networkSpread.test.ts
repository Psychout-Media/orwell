import { describe, it, expect } from "vitest";
import { NETWORK, networkMotive, rolesFromGraph } from "../../src/engine/networkSpread";
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
  it("a house with no shape adds nothing", () => {
    const flat = rolesFromGraph({ cliques: [], hubs: [], loners: [], brokers: [] }, () => 0.3);
    expect(networkMotive("x", "y", "w", flat)).toBe(0);
  });
});
