import { describe, it, expect } from "vitest";
import { buildSandbox } from "../support/sandbox";
import { spreadBetween, isRumorOrigin, type SpreadDeps } from "../../src/engine/copresenceSpread";
import { ToldLedger } from "../../src/engine/heldFacts";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { npc } from "../../src/domain/ids";

/** ORW-688: a rumor-origin retelling (scene/thread/tie/confide lineage) that only just gained a subject records no heard-rumor claim; any other subject-bearing fact still does. Roles only. */
const H = npc(1), L = npc(2), S = npc(3);
function told(factId: string, seed = 3): number {
  const sb = buildSandbox(7);
  sb.engine.knowledge.seedBelief(H, { content: "a fact the holder owns", originalContent: "a fact the holder owns", factId, subject: S, confidence: 1, hops: 0, distortion: 0, source: H }, "origin");
  let n = 0;
  const deps: SpreadDeps = {
    knowledge: sb.engine.knowledge, told: new ToldLedger(), rngFor: () => new SeededRandom(seed),
    trust: () => 0.9, affinity: () => 0.9, threat: () => 0, style: () => "emotional", volatility: () => 0.9, audienceOf: () => 0,
    onTold: () => { n++; },
  };
  spreadBetween(H, L, deps);
  return n;
}
describe("ORW-688 - rumor-origin retellings record no heard-rumor claim", () => {
  it("recognises the four rumor-origin lineages and nothing else", () => {
    for (const id of ["fact:a:1", "thread-belief:b:2", "tie-belief:c:3", "confide:d:4"]) expect(isRumorOrigin(id)).toBe(true);
    for (const id of ["know:9", "secret-power:x:1", undefined]) expect(isRumorOrigin(id)).toBe(false);
  });
  it("a rumor-origin fact with a subject fires no observer; a subject-bearing fact of another origin does (positive control)", () => {
    const seeds = Array.from({ length: 30 }, (_, i) => i + 1);
    expect(seeds.reduce((n, sd) => n + told("fact:a:1", sd), 0)).toBe(0);
    expect(seeds.reduce((n, sd) => n + told("know:9", sd), 0)).toBeGreaterThan(0);
  });
  it("is deterministic", () => { expect(told("fact:a:1")).toBe(told("fact:a:1")); });
});
