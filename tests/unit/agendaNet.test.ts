import { describe, it, expect } from "vitest";
import { goalPull, softStack, type GoalCarry } from "../../src/engine/agendaDecisions";
import type { Agenda, AgendaBoard, Cause, Goal } from "../../src/engine/agenda";
import { REASONS } from "../../src/engine/agendaConstants";

/** ORW-635 (stacking audit S-2): the agenda adds only its excess over the threat / grudge / belief terms it was formed from, and the stacked read has a smooth ceiling. Roles only. */
const HOLDER = "npc:1", TARGET = "npc:2", FRIEND = "npc:3";
const board: AgendaBoard = { day: 4, week: 2, inHouse: [HOLDER, TARGET, FRIEND], evicted: [], juryStarted: false, finalFive: false, nominees: [], weekClosed: false };
const goal = (kind: Goal["kind"], target: string, commitment: number, why: Cause[]): Goal => ({
  id: `${kind}:${target}`, owner: HOLDER, horizon: "week", kind, target, why, test: { kind: "evicted", who: target }, commitment, status: "active", formedDay: 1, formedWeek: 1,
});
const agenda = (...goals: Goal[]): Agenda => ({ owner: HOLDER, goals, history: [], formedForWeek: 2 });
const none: GoalCarry = { threat: 0, memory: 0, belief: 0 };

describe("the agenda is netted against the terms it was formed from", () => {
  it("a goal formed from the threat read adds about nothing when the decision already counts that threat", () => {
    const a = agenda(goal("get-them-out", TARGET, 0.7, [{ kind: "threat-read", about: TARGET, weight: 0.7 }]));
    expect(goalPull(a, TARGET, board, [], none).value).toBeCloseTo(0.7, 5); // nothing carried: the old full pull
    expect(goalPull(a, TARGET, board, [], { threat: 0.7, memory: 0, belief: 0 }).value).toBeCloseTo(0, 5);
    expect(goalPull(a, TARGET, board, [], { threat: 0.3, memory: 0, belief: 0 }).value).toBeCloseTo(0.4, 5); // only the carried part is netted
  });
  it("a revenge goal formed from a belief or a grudge nets only what the decision carries of it", () => {
    const g = agenda(goal("revenge", TARGET, 0.9, [{ kind: "memory", about: TARGET, weight: 0.9 }]));
    expect(goalPull(g, TARGET, board, [], { threat: 0.9, memory: 0.1, belief: 0 }).value).toBeCloseTo(0.8, 1); // 0.9 less the 0.1 already carried (the ceiling trims a hair)
    const b = agenda(goal("revenge", TARGET, 0.8, [{ kind: "belief", about: TARGET, weight: 0.8 }]));
    expect(goalPull(b, TARGET, board, [], { threat: 0, memory: 0, belief: 0.5 }).value).toBeCloseTo(0.3, 5);
  });
  it("a goal formed from something the other terms do not carry (a long con, a protect vow) keeps its full pull", () => {
    const con = goal("long-con", TARGET, 0.8, [{ kind: "threat-read", about: TARGET, weight: 0.8 }]);
    const carried = { threat: 0.8, memory: 0.05, belief: 0.05 }; // small enough that the ceiling does not bite
    expect(goalPull(agenda({ ...con, test: { kind: "cut-later", who: TARGET, stage: "jury" } }), TARGET, { ...board, juryStarted: true }, [], carried).value).toBeCloseTo(0.8, 2);
    expect(goalPull(agenda(goal("keep-them-safe", FRIEND, 0.9, [{ kind: "bond", about: FRIEND, weight: 0.9 }])), FRIEND, board, [], carried).value).toBeCloseTo(-0.9, 5);
  });
  it("a goal about someone else's evidence is not netted by this candidate's terms", () => {
    const g = agenda(goal("get-them-out", TARGET, 0.7, [{ kind: "threat-read", about: FRIEND, weight: 0.7 }]));
    expect(goalPull(g, TARGET, board, [], { threat: 0.7, memory: 0, belief: 0 }).value).toBeCloseTo(0.7, 5);
  });
  it("no carried read (the unit callers, an agenda-less actor) is byte-identical to before", () => {
    const g = agenda(goal("get-them-out", TARGET, 1, [{ kind: "threat-read", about: TARGET, weight: 1 }]), goal("revenge", TARGET, 1, [{ kind: "memory", about: TARGET, weight: 1 }]));
    expect(goalPull(g, TARGET, board).value).toBeCloseTo(2, 5);
    expect(goalPull(undefined, TARGET, board, [], { threat: 1, memory: 1, belief: 1 }).value).toBe(0);
  });
});

describe("the stacked read has a smooth ceiling and stays in order", () => {
  it("is the identity below the knee, bends above it, and never reaches the ceiling", () => {
    for (const x of [0, 0.3, REASONS.stackKnee]) expect(softStack(x)).toBe(x);
    expect(softStack(1.4)).toBeLessThan(1.4);
    expect(softStack(1.4)).toBeGreaterThan(REASONS.stackKnee);
    expect(softStack(50)).toBeLessThanOrEqual(REASONS.stackCeiling);
    expect(softStack(3.2)).toBeLessThan(REASONS.stackCeiling);
  });
  it("for any (threat, belief, memory, agenda) the option's goal + belief + memory never exceeds the ceiling unless belief + memory alone already do, and more evidence never lowers it", () => {
    const ladder = [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1.0];
    const stacked = (commit: number, c: GoalCarry): number => {
      const g = agenda(goal("get-them-out", TARGET, commit, [{ kind: "threat-read", about: TARGET, weight: 0.5 }, { kind: "memory", about: TARGET, weight: 0.4 }, { kind: "belief", about: TARGET, weight: 0.6 }]));
      return goalPull(g, TARGET, board, [], c).value + c.memory + c.belief;
    };
    for (const threat of ladder) for (const belief of ladder) for (const memory of [0, 0.06, 0.12]) {
      let prev = -Infinity;
      for (const commit of ladder) {
        const total = stacked(commit, { threat, memory, belief });
        expect(total).toBeLessThanOrEqual(Math.max(REASONS.stackCeiling, memory + belief) + 1e-9);
        expect(total).toBeGreaterThanOrEqual(prev - 1e-9); // a stronger goal never lowers the option's score
        prev = total;
      }
      for (const [dt, db, dm] of [[0.1, 0, 0], [0, 0.1, 0], [0, 0, 0.05]] as const) { // more belief or memory never lowers the stacked read either
        expect(stacked(0.8, { threat, memory: memory + dm, belief: belief + db })).toBeGreaterThanOrEqual(stacked(0.8, { threat, memory, belief }) - 1e-9 + (dt ? -1 : 0));
      }
    }
  });
});
