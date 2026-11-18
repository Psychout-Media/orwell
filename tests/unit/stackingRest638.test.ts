import { describe, it, expect } from "vitest";
import { RelationshipModel } from "../../src/engine/relationships";
import { rankApproaches, APPROACH_GRUDGE_MAX } from "../../src/engine/conversation";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { PLAYER, npc } from "../../src/domain/ids";
import { softStackSigned } from "../../src/engine/agendaDecisions";
import { REASONS } from "../../src/engine/agendaConstants";
import { mannerLeanOf, stackedGrievance } from "../../src/engine/jury";
import { MANNER_LEAN } from "../../src/engine/juryConstants";

/** ORW-638 (stacking audit S-8, S-9, S-12). Roles only. */
describe("S-8: the veto's summed bias is bounded", () => {
  it("is the identity inside the knee, bounded by the ceiling for any stack, and strictly increasing", () => {
    let prev = -Infinity;
    for (let x = -6; x <= 6; x += 0.05) {
      const y = softStackSigned(x);
      expect(Math.abs(y)).toBeLessThan(REASONS.stackCeiling);
      if (Math.abs(x) <= REASONS.stackKnee) expect(y).toBe(x);
      expect(y).toBeGreaterThan(prev);
      prev = y;
    }
  });
  it("keeps the measured -2.6..+1.9 range inside the ceiling", () => {
    expect(softStackSigned(-2.6)).toBeGreaterThan(-REASONS.stackCeiling);
    expect(softStackSigned(1.9)).toBeLessThan(REASONS.stackCeiling);
  });
});

describe("S-9: juror manner flags combine, bounded", () => {
  it("a single flag is exactly the old value", () => {
    expect(mannerLeanOf({ betrayed: true })).toBe(MANNER_LEAN.betrayed);
    expect(mannerLeanOf({ blindsided: true })).toBe(MANNER_LEAN.blindsided);
    expect(mannerLeanOf({ disrespected: true })).toBe(MANNER_LEAN.disrespected);
    expect(mannerLeanOf({ betrayed: true, intensity: 0.7 })).toBe(MANNER_LEAN.betrayed * 0.7);
    expect(mannerLeanOf({})).toBe(0);
  });
  it("betrayed + blindsided is harsher than either alone but bounded by 1.25 x the worst", () => {
    const both = mannerLeanOf({ betrayed: true, blindsided: true });
    expect(both).toBeLessThan(MANNER_LEAN.betrayed);
    expect(both).toBeGreaterThanOrEqual(MANNER_LEAN.betrayed * 1.25 - 1e-12);
    expect(both).toBeGreaterThan(MANNER_LEAN.betrayed + MANNER_LEAN.blindsided); // old flat sum was -1.1
    const all = mannerLeanOf({ betrayed: true, blindsided: true, disrespected: true });
    expect(all).toBeLessThanOrEqual(both);
    expect(all).toBeGreaterThanOrEqual(MANNER_LEAN.betrayed * 1.25 - 1e-12);
  });
  it("is order-independent and monotone in the number of flags", () => {
    expect(stackedGrievance([-0.5, -0.6])).toBe(stackedGrievance([-0.6, -0.5]));
    expect(stackedGrievance([-0.6, -0.5, -0.4])).toBeLessThanOrEqual(stackedGrievance([-0.6, -0.5]));
  });
});

describe("S-12: a grudge's pull on approach depends on temperament", () => {
  const ids = [npc(1), npc(2)];
  const rel = (): RelationshipModel => {
    const r = new RelationshipModel(0.5);
    for (const id of ids) { r.edge(id, PLAYER).trust = 0.5; r.edge(id, PLAYER).affinity = 0.5; r.edge(id, PLAYER).threat = 0.5; }
    return r;
  };
  const drive = (stance?: (n: string) => number) => new Map(rankApproaches(PLAYER, ids, rel(), new SeededRandom(3), undefined, undefined, stance).map((a) => [a.npc, a.drive] as const));
  it("absent hook and a zero hook are byte-identical", () => {
    expect(drive(() => 0)).toEqual(drive());
  });
  it("a calm holder keeps away and a volatile holder goes at them, bounded", () => {
    const base = drive();
    const d = drive((n) => (n === ids[0] ? -1 : 1));
    expect(d.get(ids[0]!)!).toBeLessThan(base.get(ids[0]!)!);
    expect(d.get(ids[1]!)!).toBeGreaterThan(base.get(ids[1]!)!);
    expect(Math.abs(d.get(ids[1]!)! - base.get(ids[1]!)!)).toBeLessThanOrEqual(APPROACH_GRUDGE_MAX + 1e-12);
  });
});
