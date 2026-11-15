import { describe, it, expect } from "vitest";
import { heldCandidates, isSealedAttribution } from "../../src/engine/heldFacts";
import type { KnowledgeFact } from "../../src/domain/knowledge";

/**
 * ORW-325 / E12 / 0129 - a vote-DEDUCTION belief ("X believes A turned on them in the eviction vote") attributes a SEALED ballot, so the generic co-presence gossip spread must never pick it up as a fact
 * to tell. Left in, the Traitors' Fury flag changed the season for everyone: the blame beliefs (and their diffused copies) took places among a pair's top candidate facts and consumed rolls, so a flag-on and
 * a flag-off season diverged on about 1 seed in 4 (BDD 0135 lines 13 and 20). Roles only.
 */
const fact = (over: Partial<KnowledgeFact> & { factId: string }): KnowledgeFact => ({ id: over.factId, content: `fact ${over.factId}`, ...over } as KnowledgeFact);

describe("ORW-325 - sealed ballot attributions are never gossip candidates", () => {
  it("recognises the seeded blame belief, its diffused copies and the jury-house blame pathway", () => {
    expect(isSealedAttribution({ factId: "traitors-fury:blame:npc:4:npc:2" })).toBe(true);
    expect(isSealedAttribution({ factId: "traitors-fury:blame:npc:4:diffused" })).toBe(true);
    expect(isSealedAttribution({ factId: "fact:npc:4:123", pathway: "jury-house:blame:npc:4" })).toBe(true);
    expect(isSealedAttribution({ factId: "fact:npc:4:123", pathway: "overheard" })).toBe(false);
    expect(isSealedAttribution({ factId: "know:12" })).toBe(false);
    expect(isSealedAttribution({ factId: "jury-grievance:npc:4:npc:1" })).toBe(false); // a grievance is a different, tellable thing
  });

  it("heldCandidates leaves them out and keeps every ordinary fact, in the same stable order", () => {
    const holder = [
      fact({ factId: "know:2" }),
      fact({ factId: "traitors-fury:blame:npc:4:npc:2" }),
      fact({ factId: "fact:npc:4:9", pathway: "jury-house:blame:npc:4" }),
      fact({ factId: "know:1" }),
      fact({ factId: "traitors-fury:blame:npc:4:diffused" }),
    ];
    const got = heldCandidates(holder, []);
    expect(got.map((c) => c.factId)).toEqual(["know:1", "know:2"]);
  });

  it("without any sealed attribution heldCandidates is unchanged", () => {
    const holder = [fact({ factId: "b" }), fact({ factId: "a" })];
    expect(heldCandidates(holder, [fact({ factId: "a" })]).map((c) => c.factId)).toEqual(["b"]);
  });
});
