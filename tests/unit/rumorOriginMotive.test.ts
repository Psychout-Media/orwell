import { describe, it, expect } from "vitest";
import { factMotive, shapedMotive } from "../../src/engine/copresenceSpread";
import { npc } from "../../src/domain/ids";

/** ORW-688 gate: a rumor-origin fact that only just gained a subject keeps its pre-change spread motive (no threat term); a fact that carried a subject before still gets it. Roles only. */
const H = npc(1), L = npc(2), S = npc(3);
const d = { affinity: () => 0.5, threat: () => 1 };
const base = { confidence: 0.6 };

describe("ORW-688 - the spread motive ignores the subject-threat term for rumor-origin facts", () => {
  it("a newly-subjected rumor-origin fact has the same motive as the same fact without a subject", () => {
    for (const factId of ["fact:a:1", "thread-belief:b:2", "tie-belief:c:3", "confide:d:4"]) {
      expect(factMotive({ ...base, subject: S, factId }, H, L, d)).toBe(factMotive({ ...base }, H, L, d));
    }
  });
  it("positive control: a subject-bearing fact of another origin still gets 0.4 x threat", () => {
    const withThreat = factMotive({ ...base, subject: S, factId: "know:9" }, H, L, d);
    expect(withThreat).toBeCloseTo(factMotive({ ...base }, H, L, d) + 0.4, 10);
    expect(factMotive({ ...base, subject: S }, H, L, d)).toBeCloseTo(withThreat, 10);
  });
  it("the shaped motive follows (no network supplied)", () => {
    expect(shapedMotive({ ...base, subject: S, factId: "fact:a:1" }, H, L, d)).toBe(factMotive({ ...base }, H, L, d));
  });
  it("is deterministic", () => {
    const a = factMotive({ ...base, subject: S, factId: "fact:a:1" }, H, L, d);
    expect(factMotive({ ...base, subject: S, factId: "fact:a:1" }, H, L, d)).toBe(a);
  });
});
