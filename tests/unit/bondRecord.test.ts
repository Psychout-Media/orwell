import { describe, it, expect } from "vitest";
import { BOND, bondOf, bondStrengthOf, commitmentFor, emptyBond, foldBreak, foldKept, foldSave, foldScene, kindOf, nightPasses, type BondStore } from "../../src/engine/bondRecord";

/** Feature 0175 - the bond record's pure rules. Roles only: a, b (a pair), c (a third). */
describe("the bond record (bondRecord.ts)", () => {
  it("a read never creates a record", () => {
    const store: BondStore = {};
    expect(bondOf(store, "a", "b")).toEqual(emptyBond());
    expect(store).toEqual({});
  });
  it("a shared scene folds every ordered pair among those there, both ways alike", () => {
    const store: BondStore = {};
    foldScene(store, "bonding", ["a", "b", "c"]);
    expect(Object.keys(store).sort()).toEqual(["a|b", "a|c", "b|a", "b|c", "c|a", "c|b"]);
    expect(store["a|b"]!.warmth).toBeCloseTo(BOND.warmthPerBond, 12);
    expect(store["a|b"]!.history).toBe(1);
  });
  it("a clash: warmth down (never below 0), a grudge and strain up; the grudge's peak is kept as it fades", () => {
    const store: BondStore = {};
    foldScene(store, "conflict", ["a", "b"]); foldScene(store, "conflict", ["a", "b"]);
    const r = store["a|b"]!;
    expect(r.warmth).toBe(0);
    expect(r.resentment).toBeCloseTo(2 * BOND.resentPerConflict, 12);
    const peak = r.peakResentment;
    for (let i = 0; i < 30; i++) nightPasses(store);
    expect(r.strain).toBe(0);
    expect(r.resentment).toBeLessThan(peak);
    expect(r.peakResentment).toBe(peak);
  });
  it("a broken deal is lopsided; a kept deal warms both; a save leaves the saved one owing the saver", () => {
    const store: BondStore = {};
    foldBreak(store, "a", "b");
    expect(store["b|a"]!.resentment).toBeCloseTo(BOND.resentPerBreak, 12);
    expect(store["a|b"]!.resentment).toBe(0);
    expect(store["a|b"]!.strain).toBeCloseTo(BOND.breakerStrain, 12);
    foldKept(store, "a", "c");
    expect(store["a|c"]!.warmth).toBeCloseTo(BOND.warmthPerKept, 12);
    expect(store["c|a"]!.warmth).toBeCloseTo(BOND.warmthPerKept, 12);
    foldSave(store, "a", "c");
    expect(store["c|a"]!.debt).toBeLessThan(0);
    expect(store["a|c"]!.debt).toBeGreaterThan(0);
  });
  it("commitment follows the pair's open deals; a deep final two is ride-or-die", () => {
    const shallow = emptyBond();
    expect(commitmentFor([], shallow)).toBe("none");
    expect(commitmentFor(["safety"], shallow)).toBe("casual");
    expect(commitmentFor(["safety", "final-two"], shallow)).toBe("final-two");
    expect(commitmentFor(["final-two"], { ...shallow, warmth: BOND.rideOrDieWarmth, history: BOND.rideOrDieHistory })).toBe("ride-or-die");
  });
  it("the kind is read from the record", () => {
    const r = emptyBond();
    expect(kindOf(r)).toBe("none");
    expect(kindOf({ ...r, warmth: 0.4 })).toBe("friendship");
    expect(kindOf({ ...r, warmth: 0.4, romance: 2 })).toBe("showmance");
    expect(kindOf({ ...r, warmth: 0.4, peakResentment: 0.5, resentment: 0.1 })).toBe("rivals-turned-allies");
    expect(kindOf({ ...r, debt: 0.5 })).toBe("protector");
    expect(kindOf({ ...r, commitment: "final-two", warmth: 0.1 })).toBe("business");
  });
  it("strength is the edge's plus warmth minus a grudge, clamped to 0..1", () => {
    expect(bondStrengthOf(0.5, emptyBond())).toBe(0.5);
    expect(bondStrengthOf(0.5, { ...emptyBond(), warmth: 1 })).toBeCloseTo(0.5 + BOND.warmthWeight, 12);
    expect(bondStrengthOf(0.1, { ...emptyBond(), resentment: 1 })).toBe(0);
    expect(bondStrengthOf(0.9, { ...emptyBond(), warmth: 1 })).toBe(1);
  });
});
