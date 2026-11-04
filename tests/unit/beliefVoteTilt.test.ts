import { describe, it, expect } from "vitest";
import { voteChoice, type SeasonCtx } from "../../src/engine/liveSeason";
import { RelationshipModel } from "../../src/engine/relationships";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/**
 * B3b (#2017) — the belief term reaches the EVICTION VOTE too: a voter who BELIEVES a nominee is targeting them (a `targets-me` claim — sometimes wrong) leans toward
 * evicting that nominee. Optional ctx provider `beliefTiltFor` (same one the nomination term uses); absent ⇒ +0 ⇒ byte-identical. Roles only.
 */
const [voter, a, b] = [npc(5), npc(1), npc(2)];
function narrowRead(): RelationshipModel {
  const rel = new RelationshipModel(0.5);
  rel.edge(voter, a).threat = 0.42; rel.edge(voter, b).threat = 0.40; // baseline: the voter evicts `a`
  return rel;
}
const ctx = (rel: RelationshipModel, beliefTiltFor?: (t: EntityId, v: EntityId) => number): SeasonCtx => ({
  player: PLAYER, statsOf: () => ({ physical: 0.5, mental: 0.5, social: 0.5 }), rel, ...(beliefTiltFor ? { beliefTiltFor } : {}),
});

describe("beliefTiltFor in voteChoice", () => {
  it("absent and zero providers give the IDENTICAL vote (byte-identical when off)", () => {
    const base = voteChoice(voter, [a, b], ctx(narrowRead()));
    expect(base).toBe(a);
    expect(voteChoice(voter, [a, b], ctx(narrowRead(), () => 0))).toBe(base);
  });
  it("a voter who believes `b` is targeting them flips a narrow vote to `b`", () => {
    expect(voteChoice(voter, [a, b], ctx(narrowRead(), (t, v) => (t === b && v === voter ? 0.12 : 0)))).toBe(b);
  });
  it("it is the VOTER's belief: a belief held by someone else does not move this voter", () => {
    expect(voteChoice(voter, [a, b], ctx(narrowRead(), (t, v) => (t === b && v === npc(9) ? 0.12 : 0)))).toBe(a);
  });
  it("a belief against the already-leading nominee only reinforces (sign check: the term never protects)", () => {
    expect(voteChoice(voter, [a, b], ctx(narrowRead(), (t) => (t === a ? 0.12 : 0)))).toBe(a);
  });
});
