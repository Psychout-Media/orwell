import { describe, it, expect } from "vitest";
import { DEAL_PLANS, buildDealPlanRetro, decidePlan, momentDue, planLean, planSourceOf, recordPlan, twoFacedChance, type PlanInputs, type PlanStore } from "../../src/engine/dealPlans";

/** Feature 0178 - two-faced deals: the pure rules. Roles only: a holder, the player. */
const base: PlanInputs = { kind: "safety", margin: 0, dealsMade: 1, temperament: 0, loyaltyDial: 1, lyingDial: 1, week: 2 };

describe("two-faced deals (dealPlans.ts)", () => {
  it("Ryne's Q1: every deal made before raises the lean, with no cap below a certainty", () => {
    expect(planLean({ ...base, dealsMade: 5 }) - planLean({ ...base, dealsMade: 4 })).toBeCloseTo(DEAL_PLANS.dealCountLean, 12);
    expect(twoFacedChance({ ...base, dealsMade: 1 })).toBe(0);
    expect(twoFacedChance({ ...base, dealsMade: 40 })).toBe(1);
    let last = -1;
    for (let k = 1; k < 40; k++) { const c = twoFacedChance({ ...base, dealsMade: k }); expect(c).toBeGreaterThanOrEqual(last); last = c; }
  });
  it("the culture moves the lean: a lying, disloyal house leans two-faced; a loyal one leans keep", () => {
    expect(planLean({ ...base, lyingDial: 1.5, loyaltyDial: 0.5 })).toBeGreaterThan(planLean(base));
    expect(planLean({ ...base, lyingDial: 0.5, loyaltyDial: 1.5 })).toBeLessThan(planLean(base));
  });
  it("a cunning temperament can be two-faced even when the weighing says keep", () => {
    expect(twoFacedChance({ ...base, temperament: 1 })).toBeCloseTo(DEAL_PLANS.baseRate, 12);
  });
  it("which plan follows the deal's kind", () => {
    const sure = { ...base, margin: 5 };
    expect(decidePlan({ ...sure, kind: "vote" }, { twoFaced: 0, which: 0.9 })).toEqual({ kind: "flip", moment: { week: 2, at: "vote" } });
    expect(decidePlan({ ...sure, kind: "final-two" }, { twoFaced: 0, which: 0 }).kind).toBe("cut-final-three");
    expect(decidePlan({ ...sure, kind: "safety" }, { twoFaced: 0, which: 0 })).toEqual({ kind: "break-at", moment: { week: 2, at: "nominations" } });
    expect(decidePlan({ ...sure, kind: "safety" }, { twoFaced: 0, which: 0.99 })).toEqual({ kind: "this-week", moment: { week: 3, at: "nominations" } });
    expect(decidePlan({ ...sure, kind: "comp-throw" }, { twoFaced: 0, which: 0 })).toEqual({ kind: "keep" }); // a kind with no two-faced plan
    expect(decidePlan(base, { twoFaced: 0.5, which: 0 })).toEqual({ kind: "keep" });
  });
  it("a plan is recorded once and never replaced; no plan reads as none", () => {
    const store: PlanStore = {};
    expect(recordPlan(store, "deal:1", "h", { kind: "flip" }, 2)).toBe(true);
    expect(recordPlan(store, "deal:1", "h", { kind: "keep" }, 3)).toBe(false);
    expect(planSourceOf(() => store).planOf("deal:1", "h")?.kind).toBe("flip");
    expect(planSourceOf(() => store).planOf("deal:2", "h")).toBeUndefined();
  });
  it("a moment is due at or after its beat in its week, and any later week", () => {
    const m = { week: 3, at: "veto" as const };
    expect(momentDue(m, 2, "vote")).toBe(false);
    expect(momentDue(m, 3, "nominations")).toBe(false);
    expect(momentDue(m, 3, "veto")).toBe(true);
    expect(momentDue(m, 3, "vote")).toBe(true);
    expect(momentDue(m, 3, "other")).toBe(false);
    expect(momentDue(m, 4, "other")).toBe(true);
  });
  it("the retrospective lists every plan and every promise the player made, dropping none", () => {
    const store: PlanStore = {};
    recordPlan(store, "deal:1", "h", { kind: "flip" }, 2);
    const deals = [
      { id: "deal:1", parties: ["h", "player"], kind: "vote" as const, terms: "a vote", status: "broken", madeWeek: 2, condition: { promisors: ["h", "player"] } },
      { id: "deal:2", parties: ["x", "y"], kind: "safety" as const, terms: "x and y", status: "open", condition: { promisors: ["x", "y"] } },
    ];
    const ledger = [{ speaker: "player", addressedTo: ["h"], kind: "promise", text: "I will keep you safe", status: "kept" }, { speaker: "h", addressedTo: ["player"], kind: "promise", text: "not yours", status: "open" }];
    const r = buildDealPlanRetro(store, deals, ledger, "player", (id) => id.toUpperCase())!;
    expect(r.secretPlans).toEqual([{ holder: { id: "h", name: "H" }, with: { id: "player", name: "PLAYER" }, dealKind: "vote", madeWeek: 2, plan: "flip", outcome: "pending" }]);
    expect(r.yourPromises.map((p) => [p.source, p.status])).toEqual([["deal", "broken"], ["said", "kept"]]);
    expect(buildDealPlanRetro(undefined, [], [], "player", (id) => id)).toBeUndefined();
  });
});
