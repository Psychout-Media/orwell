import { describe, it, expect } from "vitest";
import { AssuranceLedger, assuranceKeepWeight, decideKeep, ASSURANCE } from "../../src/engine/assurances";

/**
 * B4 / #2017 slice 1 (design S2, casual assurances - "you're safe with me"). A separate, cheap ledger (not the DealLedger): no formal verdict machinery, decays, a SMALLER break
 * than a deal break. Whether an assurer keeps it is self-interested and personality-scaled (loyal ones keep, ruthless ones break when breaking pays) - never a coin flip and never
 * bent to please the player. Pure data + deterministic predicates; flag-off wiring is slice 2. Roles only.
 */
const A = "npc:1", B = "player";

describe("AssuranceLedger", () => {
  it("records an open assurance with a week, a sincerity and a source", () => {
    const l = new AssuranceLedger();
    const a = l.add({ from: A, to: B, kind: "safe", week: 2, sincerity: 0.8, source: "player" });
    expect(a.status).toBe("open");
    expect(l.openFor(A).map((x) => x.id)).toEqual([a.id]);
    expect(l.openTo(B).length).toBe(1);
  });
  it("resolves kept / broken once and never twice", () => {
    const l = new AssuranceLedger();
    const a = l.add({ from: A, to: B, kind: "vote", week: 1, sincerity: 1, source: "npc" });
    expect(l.resolve(a.id, "broken")).toBe(true);
    expect(l.resolve(a.id, "kept")).toBe(false);
    expect(l.all[0]!.status).toBe("broken");
    expect(l.openFor(A)).toEqual([]);
  });
  it("lapses assurances older than the horizon (they decay; nothing is deleted)", () => {
    const l = new AssuranceLedger();
    l.add({ from: A, to: B, kind: "safe", week: 1, sincerity: 1, source: "player" });
    l.lapse(1 + ASSURANCE.horizonWeeks + 1);
    expect(l.all.length).toBe(1);
    expect(l.all[0]!.status).toBe("lapsed");
  });
  it("round-trips losslessly (persistence non-degradation)", () => {
    const l = new AssuranceLedger();
    l.add({ from: A, to: B, kind: "loyal", week: 3, sincerity: 0.4, source: "npc" });
    const r = AssuranceLedger.fromJSON(JSON.parse(JSON.stringify(l.toJSON())));
    expect(r.all).toEqual(l.all);
    expect(r.add({ from: B, to: A, kind: "safe", week: 4, sincerity: 1, source: "player" }).id).not.toBe(l.all[0]!.id);
  });
});

describe("keeping is self-interested and personality-scaled", () => {
  it("a loyal, low-aggression houseguest keeps more than a ruthless one", () => {
    expect(assuranceKeepWeight({ loyalty: 0.9, aggression: 0.1 })).toBeGreaterThan(assuranceKeepWeight({ loyalty: 0.1, aggression: 0.9 }));
  });
  it("keep weight is bounded", () => {
    for (const l of [0, 0.5, 1]) for (const g of [0, 0.5, 1]) {
      const w = assuranceKeepWeight({ loyalty: l, aggression: g });
      expect(w).toBeGreaterThanOrEqual(ASSURANCE.keepWeightMin);
      expect(w).toBeLessThanOrEqual(ASSURANCE.keepWeightMax);
    }
  });
  it("breaks only when the benefit of breaking exceeds the personality-scaled cost; keeps otherwise", () => {
    expect(decideKeep({ keepWeight: 0.8, sincerity: 1, breakBenefit: 0.3 })).toBe(true);
    expect(decideKeep({ keepWeight: 0.8, sincerity: 1, breakBenefit: 0.95 })).toBe(false);
    expect(decideKeep({ keepWeight: 0.3, sincerity: 1, breakBenefit: 0.5 })).toBe(false);
  });
  it("an insincere (strategic-lie) assurance is never kept for its own sake", () => {
    expect(decideKeep({ keepWeight: 0.9, sincerity: 0, breakBenefit: 0.05 })).toBe(false);
  });
  it("is deterministic and monotone in the benefit of breaking", () => {
    let flipped = false, prev = true;
    for (let b = 0; b <= 1; b += 0.05) {
      const keep = decideKeep({ keepWeight: 0.6, sincerity: 1, breakBenefit: b });
      expect(decideKeep({ keepWeight: 0.6, sincerity: 1, breakBenefit: b })).toBe(keep);
      if (prev && !keep) flipped = true;
      if (!prev) expect(keep).toBe(false);
      prev = keep;
    }
    expect(flipped).toBe(true);
  });
});

describe("a broken assurance costs less than a broken deal", () => {
  it("the impact constants are bounded and smaller than the deal-break shock", () => {
    expect(ASSURANCE.brokenTrustDrop).toBeGreaterThan(0);
    expect(ASSURANCE.brokenTrustDrop).toBeLessThan(0.3);
  });
});
