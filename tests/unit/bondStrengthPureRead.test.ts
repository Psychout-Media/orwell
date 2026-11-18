import { describe, it, expect } from "vitest";
import { RelationshipModel } from "../../src/engine/relationships";

// ORW-682 (part 2): `bondStrength` is a pure READ. It used to create a baseline edge on first read; that edge then decayed and serialized, so a read changed later play
// (the Auditor's lead: a report hook that only read `bondStrength` changed the trajectory). Roles only.
const A = "npc:1", B = "npc:2";

describe("ORW-682: reading a bond writes nothing", () => {
  it("bondStrength on an unknown pair creates no edge and reads the baseline; a known pair reads its edge", () => {
    const rel = new RelationshipModel(0.6);
    const before = JSON.stringify(rel.serialize());
    const v = rel.bondStrength(A, B);
    expect(JSON.stringify(rel.serialize())).toBe(before);
    expect(rel.allBondStrengths()).toHaveLength(0);
    expect(v).toBe(rel.peekBondStrength(A, B));
    rel.edge(A, B).trust = 0.9;
    expect(rel.bondStrength(A, B)).toBeGreaterThan(v);
  });
});
