import { describe, it, expect } from "vitest";
import { nextStepFor, LIE_AUDIENCE, type HourView } from "../../src/engine/houseLife";
import type { Agenda, AgendaCharacter, Goal } from "../../src/engine/agenda";
import type { Room } from "../../src/domain/house";

/** ORW-590 (T2-7): a planted story goes to the swing voter, not the planter's best friend. Roles only. */
const PLANTER = "npc:1", HOH = "npc:2", TARGET = "npc:3", BEST_FRIEND = "npc:4", SWING = "npc:5", CREDULOUS_SWING = "npc:6";
const char: AgendaCharacter = { archetype: "analyst", strategyStyle: "social", secretKinds: [] };
const goal: Goal = {
  id: "g", owner: PLANTER, horizon: "week", kind: "revenge", target: TARGET, why: [{ kind: "character", weight: 1 }],
  test: { kind: "survives-week" }, commitment: 1, status: "active", formedDay: 1, formedWeek: 1,
};
const agenda: Agenda = { owner: PLANTER, goals: [goal], history: [], formedForWeek: 1 };
const room = (r: Room): Room => r;
function view(over: Partial<HourView> = {}): HourView {
  return {
    owner: PLANTER, character: char, agenda, habits: [], emotional: 0.5, room: room("living-room"),
    whereabouts: new Map<string, Room>([[PLANTER, "living-room"], [HOH, "hoh-room"], [TARGET, "kitchen"], [BEST_FRIEND, "living-room"], [SWING, "living-room"], [CREDULOUS_SWING, "living-room"]]),
    affinity: new Map([[BEST_FRIEND, 0.9], [SWING, 0.5], [CREDULOUS_SWING, 0.4], [TARGET, 0.2], [HOH, 0.5]]), threat: new Map(),
    mates: [], nominees: [], hoh: HOH, timeOfDay: "afternoon", day: 3, hour: 14, inCompetition: false, candor: 0.7, ...over,
  };
}
/** The planter's step with variant chosen so the plant/wedge family lands on a speech step with a partner. */
const audience = (v: HourView): string[] => {
  const seen = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const s = nextStepFor(goal, v, (i + 0.5) / 40);
    if (s && s.kind !== "campaign-against" && s.kind !== "confront") for (const w of s.with) seen.add(w);
  }
  return [...seen];
};
const pivotOnly = (open: ReadonlySet<string>) => (l: string): number => (open.has(l) ? 1 : 0);

describe("the lie's audience is chosen by the planter's goal", () => {
  it("without a swing read the best friend is the audience (old order, byte-identical)", () => {
    expect(audience(view())).toEqual([BEST_FRIEND]);
  });

  it("a swing voter beats the best friend", () => {
    const v = view({ swing: (l) => pivotOnly(new Set([SWING]))(l) });
    expect(audience(v)).toEqual([SWING]);
  });

  it("with no swing voter it falls back to the old choice", () => {
    expect(audience(view({ swing: () => 0 }))).toEqual([BEST_FRIEND]);
  });

  it("a higher swing score (credulity, rotation) wins between two swing voters", () => {
    const v = view({ swing: (l) => (l === SWING ? 0.5 : l === CREDULOUS_SWING ? 0.9 : 0) });
    expect(audience(v)).toEqual([CREDULOUS_SWING]);
  });

  it("bond closeness is only a tiebreak between equal swing voters", () => {
    const v = view({ swing: (l) => (l === SWING || l === CREDULOUS_SWING ? 0.6 : 0) });
    expect(audience(v)).toEqual([SWING]); // the warmer of the two
    expect(LIE_AUDIENCE.bondTiebreak * 1).toBeLessThan(LIE_AUDIENCE.minPivot * LIE_AUDIENCE.credulityBase);
  });

  it("is deterministic", () => {
    const v = view({ swing: (l) => pivotOnly(new Set([SWING]))(l) });
    expect(audience(v)).toEqual(audience(v));
  });

  it("someone already in the planter's alliance is worth less than an equal outsider", () => {
    const v = view({ mates: [SWING], swing: (l) => (l === SWING || l === CREDULOUS_SWING ? 0.6 : 0) });
    expect(audience(v)).toEqual([CREDULOUS_SWING]);
  });

  it("a listener who is asleep (not in the hour view) is never chosen", () => {
    const whereabouts = new Map<string, Room>([[PLANTER, "living-room"], [HOH, "hoh-room"], [TARGET, "kitchen"], [BEST_FRIEND, "living-room"]]);
    const v = view({ whereabouts, swing: (l) => pivotOnly(new Set([SWING]))(l) });
    expect(audience(v)).toEqual([BEST_FRIEND]);
  });
});
