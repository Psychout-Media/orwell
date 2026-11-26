import { describe, it, expect } from "vitest";
import { ROUTINE_CHANGE, activeRoutines, changeRoutines, routineKey, routineNow } from "../../src/engine/routineLife";
import type { Routine } from "../../src/engine/routines";
import { floorChangeRoutine } from "../../src/engine/houseLife";
import type { AgendaCharacter } from "../../src/engine/agenda";

/** ORW-980: routines change as the houseguest changes, additively. Roles only. */
const r = (o: Partial<Routine> = {}): Routine => ({ slot: "morning", place: "kitchen", action: "cook", company: "alone", strength: 1, source: "floor", ...o });
const fresh = (a: string): Routine => r({ slot: "evening", place: "backyard", action: a });
const pair = (): Routine[] => [r(), r({ slot: "night", place: "living-room", action: "nap" })];

describe("changeRoutines: one set aside, one taken up, nothing removed", () => {
  it("retires one active routine, adds a new one, and every earlier row is still there", () => {
    const rs = pair(), before = rs.map((x) => ({ ...x }));
    expect(changeRoutines(rs, 2, () => 0.5, (taken) => fresh(taken.has("work-out") ? "x" : "work-out"))).toBe(true);
    expect(rs).toHaveLength(3);
    expect(rs.slice(0, 2).map(routineKey)).toEqual(before.map(routineKey));
    expect(rs.filter((x) => x.retiredWeek === 2)).toHaveLength(1);
    expect(rs[2]).toMatchObject({ action: "work-out", sinceWeek: 2 });
    expect(activeRoutines(rs)).toHaveLength(2);
  });
  it("a set-aside routine never pulls; the others still do", () => {
    const rs = pair();
    changeRoutines(rs, 1, (k) => (k.includes("morning") ? 1 : 0), () => fresh("work-out"));
    expect(rs[0]!.retiredWeek).toBe(1);
    expect(routineNow(rs, "morning", false, () => 0)).toBeUndefined();
    expect(routineNow(rs, "night", false, () => 0)?.action).toBe("nap");
  });
  it("once a week, at most the season's changes, never below the routines kept, nothing new => no change", () => {
    const rs = pair();
    expect(changeRoutines(rs, 3, () => 0.5, () => fresh("a"))).toBe(true);
    expect(changeRoutines(rs, 3, () => 0.5, () => fresh("b")), "same week").toBe(false);
    expect(changeRoutines(rs, 4, () => 0.5, () => fresh("b"))).toBe(true);
    expect(changeRoutines(rs, 5, () => 0.5, () => fresh("c")), "season cap").toBe(false);
    expect(ROUTINE_CHANGE.perSeason).toBe(2);
    expect(changeRoutines([r()], 1, () => 0.5, () => fresh("a")), "too few to spare").toBe(false);
    expect(changeRoutines(pair(), 1, () => 0.5, () => undefined), "nothing new to take up").toBe(false);
  });
});

describe("floorChangeRoutine", () => {
  const c = { archetype: "comp-beast" } as unknown as AgendaCharacter;
  it("takes up an act they have not kept, deterministically", () => {
    const a = floorChangeRoutine(c, "npc:1", 7, 2, new Set(["cook", "nap"]));
    expect(a).toBeDefined();
    expect(["cook", "nap"]).not.toContain(a!.action);
    expect(a!.source).toBe("floor");
    expect(floorChangeRoutine(c, "npc:1", 7, 2, new Set(["cook", "nap"]))).toEqual(a);
  });
});
