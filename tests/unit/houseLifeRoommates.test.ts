import { describe, it, expect } from "vitest";
import { chooseHourAction, type HourView, type PlannedAction } from "../../src/engine/houseLife";
import type { Agenda, AgendaCharacter, Goal } from "../../src/engine/agenda";
import type { Room } from "../../src/domain/house";
import type { TimeOfDay } from "../../src/engine/timeOfDay";

/** ORW-466 beds slice 4 - roommate life: the house drifts back to the bedrooms at night. Roles only (a holder, two roommates, a bystander). */
const HOLDER = "npc:1", ROOMIE = "npc:2", BEDMATE = "npc:3", OTHER = "npc:4";
const BED: Room = "bedroom-b";
const char: AgendaCharacter = { archetype: "analyst", strategyStyle: "social", secretKinds: [] };
function hv(over: Partial<HourView> = {}): HourView {
  return {
    owner: HOLDER, character: char, agenda: undefined, habits: [], emotional: 0.6, room: "living-room",
    whereabouts: new Map<string, Room>([[HOLDER, "living-room"], [ROOMIE, "kitchen"], [BEDMATE, "backyard"], [OTHER, "living-room"]]),
    affinity: new Map([[ROOMIE, 0.8], [BEDMATE, 0.6], [OTHER, 0.7]]), threat: new Map(),
    mates: [], nominees: [], timeOfDay: "night", day: 3, hour: 22, inCompetition: false, candor: 0.7, ...over,
  };
}
const run = (v: HourView, n = 400, tod: TimeOfDay = "night"): PlannedAction[] =>
  Array.from({ length: n }, (_, i) => chooseHourAction({ ...v, timeOfDay: tod, day: 3 + Math.floor(i / 8), hour: 20 + (i % 8) }, 1000 + i));
const share = (ps: PlannedAction[], f: (p: PlannedAction) => boolean) => ps.filter(f).length / ps.length;
const inBed = (p: PlannedAction) => p.place === BED;

describe("ORW-466 slice 4: roommate life", () => {
  it("at night a houseguest often ends the day with an awake roommate in their own bedroom; without beds, never", () => {
    const withBeds = run(hv({ bedroom: BED, roommates: [ROOMIE] }));
    const roomie = share(withBeds, (p) => inBed(p) && p.with.includes(ROOMIE));
    expect(roomie).toBeGreaterThan(0.3);
    expect(roomie).toBeLessThan(0.7);
    expect(share(run(hv()), inBed)).toBe(0);
  });

  it("the double-bed partner is the usual company, even over a roommate they like more", () => {
    const ps = run(hv({ bedroom: BED, roommates: [ROOMIE, BEDMATE], bedPartner: BEDMATE })).filter(inBed);
    expect(share(ps, (p) => p.with.includes(BEDMATE))).toBeGreaterThan(0.55);
    const noPartner = run(hv({ bedroom: BED, roommates: [ROOMIE, BEDMATE] })).filter(inBed);
    expect(share(noPartner, (p) => p.with.includes(BEDMATE))).toBeLessThan(0.45);
  });

  it("a night owl's bed talk is with roommates, in their own bedroom; a napper naps in their own bed, alone", () => {
    // nobody shares their room this hour, so any bed talk or nap comes from the habit or the roommate pull, never a chat with whoever is around
    const alone = new Map<string, Room>([[HOLDER, "living-room"], [ROOMIE, "kitchen"], [BEDMATE, "backyard"], [OTHER, "backyard"]]);
    const owl = run(hv({ whereabouts: alone, habits: ["night-owl"], bedroom: BED, roommates: [ROOMIE] })).filter((p) => p.kind === "bed-talk");
    expect(owl.length).toBeGreaterThan(0);
    expect(owl.every((p) => inBed(p) && p.with.every((w) => w === ROOMIE))).toBe(true);
    const naps = run(hv({ whereabouts: alone, habits: ["napper"], bedroom: BED, roommates: [ROOMIE] }), 200, "afternoon").filter((p) => p.kind === "nap");
    expect(naps.length).toBeGreaterThan(0);
    expect(naps.every((p) => inBed(p) && p.with.length === 0)).toBe(true);
  });

  it("a keep-my-secret goal does not cost the holder's acting goals their hours", () => {
    const g = (kind: Goal["kind"], target?: string): Goal => ({
      id: `${HOLDER}:${kind}:${target ?? "-"}`, owner: HOLDER, horizon: "week", kind, ...(target ? { target } : {}), why: [{ kind: "character", weight: 1 }],
      test: { kind: "survives-week" }, commitment: 0.9, status: "active", formedDay: 1, formedWeek: 1,
    });
    const ag = (...goals: Goal[]): Agenda => ({ owner: HOLDER, goals, history: [], formedForWeek: 1 });
    const acting = (a: Agenda) => run(hv({ agenda: a, hoh: OTHER }), 400, "afternoon").filter((p) => p.goalKind !== undefined).length;
    expect(acting(ag(g("get-them-out", ROOMIE), g("keep-my-secret")))).toBe(acting(ag(g("get-them-out", ROOMIE))));
  });
});
