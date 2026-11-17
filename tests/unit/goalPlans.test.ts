import { describe, it, expect } from "vitest";
import { GOAL_PLAN, formPlan, planStepNow, chooseHourAction, type PlanStep } from "../../src/engine/houseLife";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";

/** ORW-625 - plans that last longer than an hour. Roles only: a holder (h), a target (t), others (a, b). */
const view = (where: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  owner: "h", character: { archetype: "loyalist", strategyStyle: "social" } as never, habits: [] as never, emotional: 0.6, room: "kitchen" as never,
  whereabouts: new Map(Object.entries(where)) as never, affinity: new Map([["t", 0.6], ["a", 0.5], ["b", 0.5]]), threat: new Map([["t", 0.2], ["a", 0.2], ["b", 0.2]]),
  mates: [], nominees: [], timeOfDay: "afternoon" as never, day: 3, hour: 14, inCompetition: false, candor: 0.6, ...extra,
});
const goal = { id: "g1", kind: "pull-them-in", target: "t", commitment: 0.9, status: "active" } as never;

describe("plans (houseLife.ts)", () => {
  it("a plan is a short sequence of the goal's own steps, formed once", () => {
    const steps = formPlan(goal, view({ h: "kitchen", t: "kitchen", a: "kitchen" }) as never, { kind: "check-in", with: ["t"] }, (k) => (k * 0.37) % 1);
    expect(steps.length).toBeGreaterThan(1);
    expect(steps.length).toBeLessThanOrEqual(GOAL_PLAN.steps);
    expect(steps[0]).toEqual({ kind: "check-in", with: ["t"] });
    expect(steps.every((st) => st.with.includes("t"))).toBe(true); // working on that one person
  });
  it("the plan's step waits for its partner instead of re-rolling", () => {
    const step: PlanStep = { kind: "tell-stories", with: ["t"] };
    expect(planStepNow(step, goal, view({ h: "kitchen", a: "kitchen" }) as never)).toBeUndefined(); // t is not reachable: wait
    expect(planStepNow(step, goal, view({ h: "kitchen", t: "kitchen" }) as never)?.kind).toBe("tell-stories");
  });
  it("an hour takes the plan's step, not a re-rolled one", () => {
    const step: PlanStep = { kind: "cook", with: ["t"] };
    const hv = view({ h: "kitchen", t: "kitchen" }, { agenda: { goals: [goal] }, plans: new Map([["g1", step]]) });
    let taken = 0;
    for (let d = 1; d <= 30; d++) { const a = chooseHourAction({ ...hv, day: d } as never, 9); if (a.goalId === "g1") { expect(a.kind).toBe("cook"); taken++; } }
    expect(taken).toBeGreaterThan(0);
  });
});

describe("plans in the live house", () => {
  it("a goal's plan is carried across hours and days, advances when its steps are taken, and is dropped only for a reason", () => {
    const sb = new GameSessionRegistry().sandboxFor("goal-plans");
    sb.session.createCharacter({ playerName: "The Player", seed: 81 });
    const g = sb.session as unknown as {
      live: { playedGame?: boolean; agendas?: Record<string, { goals: Array<{ id: string; status: string }> }>; goalPlans?: Record<string, Array<{ goalId: string; steps: PlanStep[]; at: number; status: string; reason?: string; lastDay: number }>> };
      noteGoalPlan(owner: string, a: unknown, hv: unknown, day: number): void; maintainGoalPlans(owner: string, day: number): void; planStepsFor(owner: string): Map<string, PlanStep>;
    };
    g.live.playedGame = true;
    const [h, t] = sb.session.livingIds().filter((id) => id !== PLAYER);
    g.live.agendas = { ...(g.live.agendas ?? {}), [h!]: { goals: [{ id: "g1", kind: "pull-them-in", target: t!, commitment: 0.9, status: "active" } as never] } } as never;
    const hv = view({ [h!]: "kitchen", [t!]: "kitchen" }, { owner: h, affinity: new Map([[t!, 0.6]]), threat: new Map([[t!, 0.2]]) });
    g.noteGoalPlan(h!, { actor: h, kind: "check-in", with: [t!], goalId: "g1", goalKind: "pull-them-in" }, hv, 3);
    const plan = g.live.goalPlans![h!]![0]!;
    expect(plan.at).toBe(1);
    const next = g.planStepsFor(h!).get("g1")!;
    expect(next).toEqual(plan.steps[1]);
    g.noteGoalPlan(h!, { actor: h, kind: next.kind, with: next.with, goalId: "g1" }, hv, 4); // the next day, the plan's step
    expect(plan.at).toBe(2);
    g.maintainGoalPlans(h!, 4 + GOAL_PLAN.stallDays);
    expect(plan.status).toBe("dropped");
    expect(plan.reason).toBe("stalled");
    expect(g.live.goalPlans![h!]).toHaveLength(1); // the record stays
  });
});
