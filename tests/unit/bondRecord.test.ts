import { describe, it, expect } from "vitest";
import { BOND, bondOf, bondStrengthOf, commitmentFor, emptyBond, foldBreak, foldKept, foldRepair, foldSave, foldScene, kindOf, sceneRoles, nightPasses, type BondStore } from "../../src/engine/bondRecord";

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
  it("a repair eases the wronged side only: strain by the amount, the grudge by half, the worst of the grudge remembered", () => {
    const store: BondStore = {};
    foldBreak(store, "a", "b");
    const before = { ...store["b|a"]! }, breaker = { ...store["a|b"]! };
    foldRepair(store, "b", "a", 0.2);
    expect(store["b|a"]!.strain).toBeCloseTo(before.strain - 0.2, 12);
    expect(store["b|a"]!.resentment).toBeCloseTo(before.resentment - 0.2 * BOND.repairResentShare, 12);
    expect(store["b|a"]!.peakResentment).toBe(before.peakResentment);
    expect(store["b|a"]!.history).toBe(before.history + 1);
    expect(store["a|b"]).toEqual(breaker);
    foldRepair(store, "b", "a", 5);
    expect(store["b|a"]!.strain).toBe(0);
    expect(store["b|a"]!.resentment).toBe(0);
  });

  describe("ORW-598: principals vs bystanders, and who started it", () => {
    it("no initiator and no bystanders: byte-identical to the original symmetric fold", () => {
      const legacy: BondStore = {}; const same: BondStore = {};
      foldScene(legacy, "conflict", ["a", "b", "c"]);
      foldScene(same, "conflict", ["a", "b", "c"], {});
      expect(same).toEqual(legacy);
      expect(legacy["a|b"]).toEqual(legacy["b|a"]);
    });
    it("a bonding scene started by one side: the recipient's view of the starter moves in full, the starter's by a smaller nonzero share", () => {
      const store: BondStore = {};
      foldScene(store, "bonding", ["a", "b"], { initiator: "a" });
      expect(store["b|a"]!.warmth).toBeCloseTo(BOND.warmthPerBond, 12);
      expect(store["a|b"]!.warmth).toBeCloseTo(BOND.warmthPerBond * BOND.initiatorShare, 12);
      expect(store["a|b"]!.warmth).toBeGreaterThan(0);
      expect(store["a|b"]!.history).toBe(1); expect(store["b|a"]!.history).toBe(1);
    });
    it("a conflict started by one side hurts the recipient's view of the starter more than the starter's of the recipient", () => {
      const store: BondStore = {};
      foldScene(store, "conflict", ["a", "b"], { initiator: "a" });
      expect(store["b|a"]!.resentment).toBeCloseTo(BOND.resentPerConflict, 12);
      expect(store["a|b"]!.resentment).toBeCloseTo(BOND.resentPerConflict * BOND.initiatorShare, 12);
      expect(store["b|a"]!.strain).toBeGreaterThan(store["a|b"]!.strain);
    });
    it("a bystander does not move the principals' pair, and moves only their own view of each principal by the bounded share", () => {
      const store: BondStore = {};
      foldScene(store, "bonding", ["a", "b"], { initiator: "a", bystanders: ["c"] });
      expect(Object.keys(store).sort()).toEqual(["a|b", "b|a", "c|a", "c|b"]);
      expect(store["c|a"]!.warmth).toBeCloseTo(BOND.warmthPerBond * BOND.bystanderShare, 12);
      expect(store["c|a"]!.history).toBe(0);
      const alone: BondStore = {};
      foldScene(alone, "bonding", ["a", "b"], { initiator: "a" });
      expect(store["a|b"]).toEqual(alone["a|b"]); expect(store["b|a"]).toEqual(alone["b|a"]);
    });
    it("a six-witness scene still folds its principals; the other four only watched", () => {
      const roles = sceneRoles("a", ["a", "b", "c", "d", "e", "f"], false);
      expect(roles.principals).toEqual(["a", "b"]);
      expect(roles.bystanders).toEqual(["c", "d", "e", "f"]);
      const store: BondStore = {};
      foldScene(store, "bonding", roles.principals, { initiator: "a", bystanders: roles.bystanders });
      expect(store["b|a"]!.warmth).toBeCloseTo(BOND.warmthPerBond, 12);
      expect(store["c|d"]).toBeUndefined();
    });
    it("a house-life scene's witness set is its participants: all principals", () => {
      expect(sceneRoles("a", ["a", "b", "c"], true)).toEqual({ principals: ["a", "b", "c"], bystanders: [] });
    });
  });
});
