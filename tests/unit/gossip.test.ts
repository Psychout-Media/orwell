import { describe, it, expect } from "vitest";
import { makeSocialGraph, diffuseGossip } from "../../src/engine/gossip";
import { buildEngineCore } from "../../src/composition/engineRoot";
import { npc } from "../../src/domain/ids";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";

function run(seed: number) {
  const core = buildEngineCore();
  const graph = makeSocialGraph([
    [npc(1), npc(2)], [npc(2), npc(3)], [npc(3), npc(4)], [npc(4), npc(5)],
  ]);
  const { factId, original } = diffuseGossip({
    knowledge: core.knowledge, graph, rng: new SeededRandom(seed),
    origin: npc(1), fact: { content: "X" }, rounds: 6, transmitProb: 1,
  });
  const beliefs = [npc(1), npc(2), npc(3), npc(4), npc(5)]
    .map((n) => core.knowledge.knownTo(n).find((k) => k.factId === factId))
    .filter((b) => b !== undefined);
  return { core, factId, original, beliefs };
}

describe("gossip diffusion", () => {
  it("spreads one hop per round along the path", () => {
    const { beliefs } = run(11);
    expect(beliefs).toHaveLength(5);
    expect(beliefs.map((b) => b!.hops).sort((a, b) => a! - b!)).toEqual([0, 1, 2, 3, 4]);
  });

  it("confidence decays with hops", () => {
    const byHop = new Map(run(11).beliefs.map((b) => [b!.hops, b!.confidence]));
    expect(byHop.get(0)).toBe(1);
    expect(byHop.get(1)!).toBeLessThan(byHop.get(0)!);
    expect(byHop.get(2)!).toBeLessThan(byHop.get(1)!);
  });

  it("distortion strictly increases with hops", () => {
    const sorted = run(11).beliefs.sort((a, b) => a!.hops! - b!.hops!);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.distortion!).toBeGreaterThan(sorted[i - 1]!.distortion!);
    }
  });

  it("far beliefs drift from the original", () => {
    const { beliefs, original } = run(11);
    const far = beliefs.filter((b) => (b!.hops ?? 0) >= 2);
    expect(far.some((b) => b!.content !== original)).toBe(true);
  });

  it("records one traceable telling event per retelling", () => {
    const { core, beliefs } = run(11);
    const gossip = core.events.query({ type: "gossip" });
    expect(gossip).toHaveLength(4); // 4 retellings across a 5-node path
    for (const b of beliefs) {
      if (b!.hops === 0) continue;
      expect(gossip.some((g) => g.id === b!.sourceEventId)).toBe(true);
    }
  });

  it("is reproducible under a fixed seed", () => {
    expect(run(11).beliefs.map((b) => b!.content)).toEqual(run(11).beliefs.map((b) => b!.content));
  });
});

describe("gossip diffusion — memoized belief read (#1922 perf, byte-identical)", () => {
  it("the returned beliefOf agrees with a fresh knownTo read for every node, held or not", () => {
    for (const transmitProb of [1, 0.5, 0]) {
      const core = buildEngineCore();
      const nodes = [npc(1), npc(2), npc(3), npc(4), npc(5), npc(6)];
      const graph = makeSocialGraph([
        [npc(1), npc(2)], [npc(1), npc(3)], [npc(2), npc(4)], [npc(3), npc(4)], [npc(4), npc(5)],
      ]);
      // A prior, unrelated belief on a node so the memo must pick THIS fact out of a longer list.
      core.knowledge.seedBelief(npc(4), { content: "older", factId: "older", confidence: 1, hops: 0, source: npc(4) }, "origin");
      const { factId, beliefOf } = diffuseGossip({
        knowledge: core.knowledge, graph, rng: new SeededRandom(7),
        origin: npc(1), fact: { content: "X" }, rounds: 4, transmitProb,
      });
      for (const n of nodes) {
        expect(beliefOf(n)).toEqual(core.knowledge.knownTo(n).find((k) => k.factId === factId));
      }
    }
  });
});
