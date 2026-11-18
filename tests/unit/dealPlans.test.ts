import { describe, it, expect } from "vitest";
import { npcAssuranceSincerity } from "../../src/engine/assurances";
import { DEAL_PLANS, FAKING, PLAN_SEMANTICS, planSemantics, fakingLean, isBetrayal, planBond, buildDealPlanRetro, decidePlan, momentDue, planLean, planSourceOf, recordPlan, twoFacedChance, type PlanInputs, type PlanStore } from "../../src/engine/dealPlans";

/** Feature 0178 - two-faced deals: the pure rules. Roles only: a holder, the player. */
const base: PlanInputs = { kind: "safety", margin: 0, dealsMade: 1, temperament: 0, loyaltyDial: 1, lyingDial: 1, week: 2 };

describe("two-faced deals (dealPlans.ts)", () => {
  it("Ryne's Q1: every deal made before raises the chance, with no cap below a certainty", () => {
    expect(twoFacedChance({ ...base, dealsMade: 5 }) - twoFacedChance({ ...base, dealsMade: 4 })).toBeCloseTo(FAKING.perPastDeal, 12);
    expect(twoFacedChance({ ...base, dealsMade: 40 })).toBe(1);
    let last = -1;
    for (let k = 1; k < 40; k++) { const c = twoFacedChance({ ...base, dealsMade: k }); expect(c).toBeGreaterThanOrEqual(last); last = c; }
  });
  it("the shared faking dials: readiness spread by the person, plus the per-past-deal lean", () => {
    expect(fakingLean(1, 0)).toBeCloseTo(FAKING.readiness * FAKING.personFloor, 12);
    expect(fakingLean(1, 1)).toBeCloseTo(FAKING.readiness * (FAKING.personFloor + FAKING.personSpan), 12);
    expect(fakingLean(4, 0) - fakingLean(1, 0)).toBeCloseTo(3 * FAKING.perPastDeal, 12);
  });
  it("Ryne 2026-11-17 (paranoia): a cunning type fakes even with every reason to keep; a loyal type rarely does", () => {
    const cunning = twoFacedChance({ ...base, temperament: 0.95, margin: -5 });
    const loyal = twoFacedChance({ ...base, temperament: 0.1, margin: -5 });
    expect(cunning).toBeGreaterThan(0.25);
    expect(loyal).toBeLessThan(cunning / 2);
  });
  it("the culture moves it: a lying, disloyal house leans two-faced; a loyal one leans keep", () => {
    expect(planLean({ ...base, lyingDial: 1.5, loyaltyDial: 0.5 })).toBeGreaterThan(planLean(base));
    expect(planLean({ ...base, lyingDial: 0.5, loyaltyDial: 1.5 })).toBeLessThan(planLean(base));
  });
  it("which plan follows the deal's kind", () => {
    const sure = { ...base, margin: 5 };
    expect(decidePlan({ ...sure, kind: "vote" }, { twoFaced: 0, which: 0.9 })).toEqual({ kind: "flip", moment: { week: 2, at: "vote" } });
    expect(decidePlan({ ...sure, kind: "final-two" }, { twoFaced: 0, which: 0 }).kind).toBe("cut-final-three");
    expect(decidePlan({ ...sure, kind: "safety" }, { twoFaced: 0, which: 0 })).toEqual({ kind: "break-at", moment: { week: 2, at: "nominations" } });
    // ORW-601: a safety deal ends at the week roll anyway, so its other two-faced shape is a flip at this week's vote, never "this week only" (= keeping it)
    expect(decidePlan({ ...sure, kind: "safety" }, { twoFaced: 0, which: 0.99 })).toEqual({ kind: "flip", moment: { week: 2, at: "vote" } });
    // a betrayal that waits a week is a break at next week's nominations
    expect(decidePlan({ ...sure, kind: "target-other" }, { twoFaced: 0, which: 0.99 })).toEqual({ kind: "break-at", moment: { week: 3, at: "nominations" } });
    expect(decidePlan({ ...sure, kind: "final-two" }, { twoFaced: 0, which: 0.99 })).toEqual({ kind: "break-at", moment: { week: 3, at: "nominations" } });
    expect(decidePlan({ ...sure, kind: "comp-throw" }, { twoFaced: 0, which: 0 })).toEqual({ kind: "keep" }); // a kind with no two-faced plan
    expect(decidePlan(base, { twoFaced: 0.5, which: 0 })).toEqual({ kind: "keep" });
  });
  it("Fable T3-5 item 2 (Ryne's Q1 names the bond): a best friend fakes far less than with a distrusted, threatening partner, whatever the margin's clamp", () => {
    const friend = planBond({ trust: 0.9, affinity: 0.9, threat: 0 }), foe = planBond({ trust: 0.1, affinity: 0.1, threat: 0.6 });
    const at = (bond: number) => twoFacedChance({ ...base, temperament: 0.5, margin: -5, bond });
    expect(at(foe) - at(friend)).toBeGreaterThan(0.3); // not "within a few points"
    expect(at(friend)).toBeLessThan(twoFacedChance({ ...base, temperament: 0.5, margin: -5 }));
    expect(at(foe)).toBeGreaterThan(twoFacedChance({ ...base, temperament: 0.5, margin: -5 }));
    expect(at(DEAL_PLANS.bondNeutral)).toBeCloseTo(twoFacedChance({ ...base, temperament: 0.5, margin: -5 }), 12); // a neutral bond moves nothing
  });
  it("the plan-semantics table: one answer to 'is it a betrayal, how is it carried out, when does it expire', and every shape the planner deals is a betrayal", () => {
    expect(Object.keys(PLAN_SEMANTICS).sort()).toEqual(["break-at", "cut-final-three", "flip", "keep"]);
    expect(isBetrayal("keep")).toBe(false);
    // ORW-601: there is no "this-week" plan (it was the same as keeping); a plan from an older save under a retired kind reads as keep
    expect(isBetrayal("this-week" as never)).toBe(false);
    expect(planSemantics("this-week" as never)).toEqual(PLAN_SEMANTICS.keep);
    expect(PLAN_SEMANTICS.flip.carriedOut).toBe("vote");
    for (const kind of ["safety", "vote", "final-two", "target-other", "protect-third"] as const)
      for (let r = 0; r < 1; r += 0.05) {
        const p = decidePlan({ ...base, kind, margin: 5 }, { twoFaced: 0, which: r });
        expect(isBetrayal(p.kind)).toBe(true);
        expect(PLAN_SEMANTICS[p.kind].carriedOut === "final-three" || p.moment !== undefined).toBe(true);
      }
  });
  it("ORW-601: the retune lifts FIRST deals - an even spread of people, an ordinary margin and bond, about 1 in 5 on a first deal (was under 3%), rising with each deal", () => {
    const people = Array.from({ length: 10 }, (_, k) => 0.05 + k * 0.1);
    const mean = (dealsMade: number) => people.reduce((a, c) => a + twoFacedChance({ ...base, margin: -0.5, bond: DEAL_PLANS.bondNeutral, dealsMade, temperament: c }), 0) / people.length;
    expect(mean(1)).toBeGreaterThan(0.15);
    expect(mean(1)).toBeLessThan(0.25);
    expect(mean(4)).toBeGreaterThan(0.5);
    for (const c of people) expect(twoFacedChance({ ...base, margin: -0.5, bond: DEAL_PLANS.bondNeutral, dealsMade: 1, temperament: c })).toBeGreaterThan(0.04); // no one is at zero on a first deal
  });
  it("ORW-601: a casual assurance is faked on the same model as a deal (the shared chance), and the older loyalty rule only stands when none is passed", () => {
    const pFake = twoFacedChance({ ...base, margin: -0.5, dealsMade: 1, temperament: 0.5 });
    let lies = 0;
    const N = 1000;
    for (let k = 0; k < N; k++) if (npcAssuranceSincerity(1, (k + 0.5) / N, pFake) < 1) lies++;
    expect(lies / N).toBeCloseTo(pFake, 2);
    expect(npcAssuranceSincerity(1, 0.99)).toBe(1); // no shared chance: a fully loyal houseguest is always sincere
  });
  it("ORW-601: no plan is 'this week only' - a safety deal's two-faced shapes are a break at the nominations or a flip at the vote, and every shape is a betrayal", () => {
    const kinds = new Set<string>();
    for (const kind of ["safety", "target-other", "protect-third", "vote", "final-two"] as const)
      for (let r = 0; r < 1; r += 0.01) kinds.add(decidePlan({ ...base, kind, margin: 5 }, { twoFaced: 0, which: r }).kind);
    expect(kinds.has("this-week")).toBe(false);
    expect([...kinds].sort()).toEqual(["break-at", "cut-final-three", "flip"]);
    const safety = new Set<string>();
    for (let r = 0; r < 1; r += 0.01) safety.add(decidePlan({ ...base, kind: "safety", margin: 5 }, { twoFaced: 0, which: r }).kind);
    expect([...safety].sort()).toEqual(["break-at", "flip"]);
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
