import { describe, it, expect } from "vitest";
import { voteChoice, type SeasonCtx } from "../../src/engine/liveSeason";
import { nominationPlan } from "../../src/engine/season";
import { RelationshipModel } from "../../src/engine/relationships";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/** B29: the exploit tilt (`moodTiltFor`) reaches the EVICTION VOTE and the HOH's NOMINATIONS. Absent/zero => identical (byte-identical when off); it is the holder's own tilt; it only ever pushes TOWARD the rattled. Roles only. */
const [voter, a, b] = [npc(5), npc(1), npc(2)];
const narrow = (): RelationshipModel => { const rel = new RelationshipModel(0.5); rel.edge(voter, a).threat = 0.42; rel.edge(voter, b).threat = 0.40; return rel; };
const ctx = (rel: RelationshipModel, moodTiltFor?: (t: EntityId, v: EntityId) => number): SeasonCtx => ({
  player: PLAYER, statsOf: () => ({ physical: 0.5, mental: 0.5, social: 0.5 }), rel, ...(moodTiltFor ? { moodTiltFor } : {}),
});

describe("moodTiltFor in voteChoice", () => {
  it("absent and zero providers give the identical vote", () => {
    const base = voteChoice(voter, [a, b], ctx(narrow()));
    expect(base).toBe(a);
    expect(voteChoice(voter, [a, b], ctx(narrow(), () => 0))).toBe(base);
  });
  it("a voter who saw `b` rattled and is exploiting it flips a narrow vote to `b`; it is THEIR tilt (someone else's does nothing)", () => {
    expect(voteChoice(voter, [a, b], ctx(narrow(), (t, v) => (t === b && v === voter ? 0.1 : 0)))).toBe(b);
    expect(voteChoice(voter, [a, b], ctx(narrow(), (t, v) => (t === b && v === npc(9) ? 0.1 : 0)))).toBe(a);
  });
});

describe("moodPush in nominationPlan", () => {
  it("a HOH exploiting a rattled houseguest nominates them over an otherwise-equal candidate", () => {
    const active: EntityId[] = [voter, a, b, npc(3), npc(4)];
    const rel = new RelationshipModel(0.5);
    for (const t of [a, b, npc(3)]) rel.edge(voter, t).threat = 0.6;
    rel.edge(voter, npc(4)).threat = 0.05; // the least threatening: not nominated on the board alone
    const plain = nominationPlan(voter, active, rel, {});
    const rattled = nominationPlan(voter, active, rel, { moodPush: (t) => (t === npc(4) ? 0.9 : 0) });
    expect(plain.nominees).not.toContain(npc(4));
    expect(rattled.nominees).toContain(npc(4));
    expect(nominationPlan(voter, active, rel, { moodPush: () => 0 }).nominees).toEqual(plain.nominees);
  });
});
