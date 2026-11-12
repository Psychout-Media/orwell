import { describe, it, expect, vi } from "vitest";
import { ACTIONS, HABITS, habitsFor, chooseHourAction, assembleScenes, type HourView, type PlannedAction, type ActionKind } from "../../src/engine/houseLife";
import type { Agenda, AgendaCharacter, Goal } from "../../src/engine/agenda";
import type { Room } from "../../src/domain/house";
import type { TimeOfDay } from "../../src/engine/timeOfDay";
import type { Archetype } from "../../src/engine/characterFactory";

/** ORW-253 slice 3 core: every awake houseguest acts once an hour, from their goals, habits and mood; actions merge into scenes. Roles only. */
const HOLDER = "npc:1", HOH = "npc:2", TARGET = "npc:3", FRIEND = "npc:4", VOTER = "npc:5", PLAYER = "player";
const SEED = 77;
const char = (archetype: Archetype = "analyst"): AgendaCharacter => ({ archetype, strategyStyle: "social", secretKinds: [] });
const goal = (kind: Goal["kind"], target: string | undefined, commitment = 1): Goal => ({
  id: `${HOLDER}:${kind}:${target ?? "-"}`, owner: HOLDER, horizon: "week", kind, ...(target ? { target } : {}), why: [{ kind: "character", weight: 1 }],
  test: { kind: "survives-week" }, commitment, status: "active", formedDay: 1, formedWeek: 1,
});
const agenda = (...goals: Goal[]): Agenda => ({ owner: HOLDER, goals, history: [], formedForWeek: 1 });
function hv(over: Partial<HourView> = {}): HourView {
  return {
    owner: HOLDER, character: char(), agenda: undefined, habits: [], emotional: 0.5, room: "living-room",
    whereabouts: new Map<string, Room>([[HOLDER, "living-room"], [HOH, "hoh-room"], [TARGET, "kitchen"], [FRIEND, "living-room"], [VOTER, "backyard"], [PLAYER, "kitchen"]]),
    affinity: new Map([[FRIEND, 0.8], [VOTER, 0.6], [TARGET, 0.2], [HOH, 0.5], [PLAYER, 0.5]]), threat: new Map([[TARGET, 0.8]]),
    mates: [], nominees: [], timeOfDay: "afternoon", day: 3, hour: 14, inCompetition: false, candor: 0.7, ...over,
  };
}
/** Run `n` hours and collect the plans (same view, hour advancing). */
const hours = (v: HourView, n = 40, tod?: TimeOfDay): PlannedAction[] =>
  Array.from({ length: n }, (_, i) => chooseHourAction({ ...v, hour: 8 + (i % 16), day: 3 + Math.floor(i / 16), ...(tod ? { timeOfDay: tod } : {}) }, SEED));

describe("the action library is built from parts, not 7 stock scenes", () => {
  it("has at least 40 actions in seven families", () => {
    expect(Object.keys(ACTIONS).length).toBeGreaterThanOrEqual(40);
    expect(new Set(Object.values(ACTIONS).map((a) => a.family)).size).toBe(7);
  });

  it("a house of different people produces many different actions over a few days", () => {
    const kinds = new Set<ActionKind>();
    const archetypes: Archetype[] = ["comp-beast", "mastermind", "floater", "hothead", "peacemaker", "flirt"];
    for (const [i, k] of archetypes.entries()) {
      const owner = `npc:${10 + i}`;
      const goals = i % 2 === 0 ? [{ ...goal("get-them-out", TARGET, 0.7), owner }, { ...goal("pull-them-in", VOTER, 0.6), owner }] : [];
      const v = hv({ owner, character: char(k), habits: habitsFor(char(k), owner, SEED), emotional: 0.2 + i * 0.12, showmance: k === "flirt" ? FRIEND : undefined,
        agenda: { owner, goals, history: [], formedForWeek: 1 }, hoh: i === 2 ? undefined : HOH, nominees: i === 4 ? [owner, TARGET] : [],
        whereabouts: new Map<string, Room>([[owner, "living-room"], [FRIEND, "living-room"], [TARGET, "living-room"], [VOTER, "kitchen"], [HOH, "hoh-room"]]) });
      for (const tod of ["morning", "afternoon", "evening", "night", "late-night"] as TimeOfDay[]) for (const p of hours(v, 12, tod)) kinds.add(p.kind);
    }
    expect(kinds.size).toBeGreaterThanOrEqual(15);
  });
});

describe("goals cause actions (the scene carries its purpose)", () => {
  it("a houseguest after a target goes to the HOH to campaign against them, on purpose", () => {
    const plans = hours(hv({ agenda: agenda(goal("get-them-out", TARGET)), hoh: HOH, timeOfDay: "evening" }));
    const camp = plans.find((p) => p.kind === "campaign-against")!;
    expect(camp).toMatchObject({ with: [HOH], about: TARGET, place: "hoh-room", goalKind: "get-them-out" });
  });

  it("a nominee spends hours working the voters (begging or calling in a favor), never the HOH", () => {
    const plans = hours(hv({ agenda: agenda(goal("stay-safe", undefined)), nominees: [HOLDER, TARGET], hoh: HOH, timeOfDay: "evening",
      affinity: new Map([[HOH, 0.95], [TARGET, 0.9], [FRIEND, 0.7], [VOTER, 0.6]]) }));
    const asks = plans.filter((p) => p.kind === "beg" || p.kind === "call-in-favor");
    expect(asks.length).toBeGreaterThan(0);
    expect(asks.every((p) => p.with[0] !== HOH && p.with[0] !== TARGET)).toBe(true);
  });

  it("recruiting goes to the person being recruited; a long con keeps the mark close", () => {
    expect(hours(hv({ agenda: agenda(goal("pull-them-in", VOTER)), timeOfDay: "evening" })).some((p) => (p.kind === "pitch" || p.kind === "recruit") && p.with[0] === VOTER && p.place === "backyard")).toBe(true);
    expect(hours(hv({ agenda: agenda(goal("long-con", TARGET)), timeOfDay: "evening" })).some((p) => p.kind === "check-in" && p.with[0] === TARGET)).toBe(true);
  });

  it("a weak goal loses many hours to ordinary life; a strong one is pursued more", () => {
    const pursued = (c: number) => hours(hv({ agenda: agenda(goal("get-them-out", TARGET, c)) }), 80).filter((p) => p.goalId).length;
    expect(pursued(1)).toBeGreaterThan(pursued(0.3) + 10);
  });

  it("an NPC may go to the player because of a goal (the player is a partner, never an actor)", () => {
    const v = hv({ agenda: agenda(goal("pull-them-in", PLAYER)), timeOfDay: "evening" });
    const p = hours(v).find((x) => x.with[0] === PLAYER)!;
    expect(p.actor).toBe(HOLDER);
    expect(p.place).toBe("kitchen");
  });
});

describe("everyday life, habits and mood", () => {
  it("habits lean on character, and a gym rat with nothing pressing works out in the backyard in the morning", () => {
    let beasts = 0, floaters = 0;
    for (let i = 0; i < 100; i++) {
      if (habitsFor(char("comp-beast"), `npc:${i}`, SEED).includes("gym-rat")) beasts++;
      if (habitsFor(char("floater"), `npc:${i}`, SEED).includes("gym-rat")) floaters++;
    }
    expect(beasts).toBeGreaterThan(floaters + 20);
    const gym = hours(hv({ habits: ["gym-rat"] }), 40, "morning").filter((p) => p.kind === "work-out");
    expect(gym.length).toBeGreaterThan(0);
    expect(gym.every((p) => p.place === "backyard")).toBe(true);
    expect(HABITS.length).toBeGreaterThanOrEqual(10);
  });

  it("a low mood turns inward or to a friend", () => {
    const plans = hours(hv({ emotional: 0.15 }), 40);
    expect(plans.some((p) => p.kind === "homesick-talk" && p.with[0] === FRIEND)).toBe(true);
    const alone = hours(hv({ emotional: 0.15, whereabouts: new Map<string, Room>([[HOLDER, "bedroom-a"], [TARGET, "kitchen"]]) }), 40);
    expect(alone.every((p) => ["mull", "vent-in-diary-room"].includes(p.kind) || p.goalId)).toBe(true);
  });

  it("people who dislike each other sometimes fight over chores", () => {
    const plans = hours(hv({ affinity: new Map([[FRIEND, 0.1]]), whereabouts: new Map<string, Room>([[HOLDER, "kitchen"], [FRIEND, "kitchen"]]), room: "kitchen" }), 80);
    expect(plans.some((p) => p.kind === "chore-fight")).toBe(true);
  });

  it("a showmance pair spends free hours together", () => {
    expect(hours(hv({ showmance: FRIEND }), 60).some((p) => (p.kind === "flirt" || p.kind === "cuddle") && p.with[0] === FRIEND)).toBe(true);
  });
});

describe("the rules stay", () => {
  it("during a competition only public reactions happen, where they stand", () => {
    const plans = hours(hv({ inCompetition: true, agenda: agenda(goal("get-them-out", TARGET)), emotional: 0.5 }));
    expect(plans.every((p) => ACTIONS[p.kind].publicOnly && p.place === "living-room")).toBe(true);
    expect(hours(hv({ inCompetition: true, emotional: 0.2 })).every((p) => p.kind === "sulk")).toBe(true);
  });

  it("every partner is someone awake in the house (no one is acted with who isn't there)", () => {
    const v = hv({ agenda: agenda(goal("get-them-out", TARGET), goal("pull-them-in", VOTER)), habits: ["storyteller", "card-shark"] });
    for (const tod of ["morning", "afternoon", "evening", "night", "late-night"] as TimeOfDay[]) {
      for (const p of hours(v, 30, tod)) for (const w of p.with) expect(v.whereabouts.has(w)).toBe(true);
    }
  });

  it("scheming speech is false more often than plain speech, and the engine marks it", () => {
    const lies = (g: Goal) => hours(hv({ agenda: agenda(g), timeOfDay: "evening", candor: 0.6 }), 200).filter((p) => ACTIONS[p.kind].speech && p.goalId);
    const con = lies(goal("long-con", TARGET)), plain = lies(goal("pull-them-in", VOTER));
    const rate = (xs: PlannedAction[]) => xs.filter((p) => !p.truthful).length / Math.max(1, xs.length);
    expect(rate(con)).toBeGreaterThan(rate(plain) + 0.2);
    expect(hours(hv({ habits: ["gym-rat"] }), 40, "morning").filter((p) => !ACTIONS[p.kind].speech).every((p) => p.truthful)).toBe(true);
  });

  it("is deterministic and touches no shared random stream", () => {
    const spy = vi.spyOn(Math, "random");
    const v = hv({ agenda: agenda(goal("get-them-out", TARGET)), habits: ["house-cook"] });
    expect(hours(v)).toEqual(hours(v));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("one hour's actions become scenes", () => {
  const a = (actor: string, kind: ActionKind, w: string[], place: Room): PlannedAction => ({ actor, kind, with: w, place, manner: "warm", truthful: true });
  it("two people acting on each other in one room are one scene, each with their own purpose; solo actions and other rooms stay apart", () => {
    const scenes = assembleScenes([a(VOTER, "beg", [FRIEND], "kitchen"), a(FRIEND, "bargain", [VOTER], "kitchen"), a(TARGET, "mull", [], "kitchen"), a(HOH, "pitch", [FRIEND], "backyard")]);
    const kitchen = scenes.find((s) => s.place === "kitchen" && s.actions.length === 2)!;
    expect(kitchen.participants).toEqual([FRIEND, VOTER].sort());
    expect(kitchen.actions.map((x) => x.kind).sort()).toEqual(["bargain", "beg"]);
    expect(scenes.length).toBe(3);
  });
});
