import { describe, it, expect } from "vitest";
import { disclosureDecision, disclosureOdds, topHeldFacts, DISCLOSURE, type DisclosureInput } from "../../src/engine/disclosure";

/** B11 / B10 slice 1 - the pure hold/share/slip decision. Roles only. */
const base: DisclosureInput = {
  motive: 0.5, holderTrustsListener: 0.6, listenerTrustsHolder: 0.6, risk: 0.2, audience: 0,
  leakiness: 0.3, cunning: 0.2, rattled: 0, pressure: 0, roll: 0.5,
};
const odds = (o: Partial<DisclosureInput> = {}) => disclosureOdds({ ...base, ...o });

describe("B10 S1 - disclosureDecision", () => {
  it("is deterministic for the same input", () => {
    expect(disclosureDecision(base)).toEqual(disclosureDecision({ ...base }));
  });
  it("share odds rise with motive and with trust", () => {
    expect(odds({ motive: 0.9 }).share).toBeGreaterThan(odds({ motive: 0.3 }).share);
    expect(odds({ holderTrustsListener: 0.9 }).share).toBeGreaterThan(odds({ holderTrustsListener: 0.4 }).share);
  });
  // ORW-38 mutation sweep (#2135): each term below was droppable with the suite staying green.
  it("share odds rise with the listener's trust in the holder and with a recorded press", () => {
    expect(odds({ listenerTrustsHolder: 0.9 }).share).toBeGreaterThan(odds({ listenerTrustsHolder: 0.1 }).share);
    expect(odds({ pressure: 0.9 }).share).toBeGreaterThan(odds({ pressure: 0 }).share);
  });
  it("a riskier (ungated) fact is shared less", () => {
    expect(odds({ risk: 0.5 }).share).toBeLessThan(odds({ risk: 0.1 }).share);
  });
  it("a recorded press raises slip", () => {
    expect(odds({ pressure: 1 }).slip).toBeGreaterThan(odds({ pressure: 0 }).slip);
  });
  it("a crowd lowers deliberate sharing, bounded by the floor", () => {
    expect(odds({ audience: 3 }).share).toBeLessThan(odds({ audience: 0 }).share);
    expect(odds({ audience: 50, motive: 1, risk: 0 }).share).toBeGreaterThan(0);
  });
  it("a risky fact is never shared on purpose with a near-stranger", () => {
    expect(odds({ risk: 0.9, motive: 1, pressure: 1, holderTrustsListener: DISCLOSURE.trustGate - 0.01 }).share).toBe(0);
    for (const roll of [0, 0.1, 0.5, 0.9]) {
      expect(disclosureDecision({ ...base, risk: 0.9, motive: 1, holderTrustsListener: 0.1, roll }).decision).not.toBe("share");
    }
  });
  it("slip rises with leakiness and a rattled state, and is bounded", () => {
    expect(odds({ leakiness: 0.9 }).slip).toBeGreaterThan(odds({ leakiness: 0.1 }).slip);
    expect(odds({ rattled: 1 }).slip).toBeGreaterThan(odds({ rattled: 0 }).slip);
    expect(odds({ leakiness: 9, rattled: 9, pressure: 9 }).slip).toBeLessThanOrEqual(DISCLOSURE.maxSlip);
  });
  it("odds are bounded: share <= maxShare, never NaN on garbage input", () => {
    const o = odds({ motive: 99, pressure: 99, holderTrustsListener: 99, listenerTrustsHolder: 99, risk: -5 });
    expect(o.share).toBeLessThanOrEqual(DISCLOSURE.maxShare);
    const n = odds({ motive: NaN, risk: NaN, leakiness: NaN });
    expect(Number.isNaN(n.share) || Number.isNaN(n.slip)).toBe(false);
  });
  it("the roll partitions share / slip / hold in order", () => {
    const { share, slip } = odds();
    expect(share).toBeGreaterThan(0);
    expect(disclosureDecision({ ...base, roll: 0 }).decision).toBe("share");
    expect(disclosureDecision({ ...base, roll: share + slip / 2 }).decision).toBe("slip");
    expect(disclosureDecision({ ...base, roll: 0.999 }).decision).toBe("hold");
  });
  it("spin follows cunning only on a share", () => {
    expect(disclosureDecision({ ...base, cunning: 0.1, roll: 0 }).spin).toBe("truthful");
    expect(disclosureDecision({ ...base, cunning: 0.6, roll: 0 }).spin).toBe("spun");
    expect(disclosureDecision({ ...base, cunning: 0.95, roll: 0 }).spin).toBe("lie");
    expect(disclosureDecision({ ...base, roll: 0.999 }).spin).toBeUndefined();
  });
  it("topHeldFacts takes the top-K by motive with a stable id tiebreak", () => {
    const facts = [{ factId: "c", motive: 0.5, risk: 0 }, { factId: "a", motive: 0.5, risk: 0 }, { factId: "b", motive: 0.9, risk: 0 }];
    expect(topHeldFacts(facts).map((f) => f.factId)).toEqual(["b", "a"]);
    expect(topHeldFacts([...facts].reverse()).map((f) => f.factId)).toEqual(["b", "a"]);
    expect(topHeldFacts(facts, 0)).toEqual([]);
  });
});
