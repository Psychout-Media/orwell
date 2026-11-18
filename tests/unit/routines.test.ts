import { describe, it, expect } from "vitest";
import { ROUTINES, followsRoutine, upBeforeTheCall, knowsRoutine, validRoutine, composeFloorRoutine, type Routine } from "../../src/engine/routines";
import { HOUSE_ROOMS } from "../../src/domain/house";
import { ACTIONS } from "../../src/engine/houseLife";

/** ORW-651 foundation: routines from the backstory. Roles only. */
const rooms = new Set<string>(HOUSE_ROOMS);
const slots = new Set(["morning", "afternoon", "evening", "night", "late-night"]);
const actions = new Set(Object.keys(ACTIONS));
const r = (o: Partial<Routine> = {}): Routine => ({ slot: "morning", place: "kitchen", action: "cook", company: "alone", strength: 1, source: "floor", ...o });

describe("ORW-651 foundation: a routine shapes where someone is and what they do", () => {
  it("pulls only at its time, by strength, and slips under stress", () => {
    expect(followsRoutine(r(), "evening", false, 0)).toBe(false);
    const p = ROUTINES.followAtFull;
    expect(followsRoutine(r(), "morning", false, p - 0.01)).toBe(true);
    expect(followsRoutine(r(), "morning", true, p - 0.01)).toBe(false);
    expect(followsRoutine(r(), "morning", true, p * ROUTINES.stressedShare - 0.01)).toBe(true);
  });
  it("a strong morning routine is up before the call; others learn a routine only by seeing it on separate days", () => {
    expect(upBeforeTheCall([r()])).toBe(true);
    expect(upBeforeTheCall([r({ strength: 0.3 }), r({ slot: "night" })])).toBe(false);
    expect(knowsRoutine(ROUTINES.learnAfterDays - 1)).toBe(false);
    expect(knowsRoutine(ROUTINES.learnAfterDays)).toBe(true);
  });
});

describe("ORW-651 foundation: authored from the backstory, with a composed floor", () => {
  it("an authored routine is checked against the house and kept in its own words; a bad one is dropped, never repaired", () => {
    const ok = validRoutine({ slot: "night", place: "backyard", action: "tell-stories", company: "whoever", strength: 2, gist: "  stargazing like back on the farm " }, rooms, slots, actions);
    expect(ok).toMatchObject({ slot: "night", place: "backyard", strength: 1, source: "authored", gist: "stargazing like back on the farm" });
    expect(validRoutine({ slot: "night", place: "the-moon", action: "cook" }, rooms, slots, actions)).toBeUndefined();
    expect(validRoutine({ slot: "noon", place: "kitchen", action: "cook" }, rooms, slots, actions)).toBeUndefined();
    expect(validRoutine({ slot: "night", place: "kitchen", action: "juggle" }, rooms, slots, actions)).toBeUndefined();
  });
  it("the floor composes from the character's candidates on separate rolls, over a space far wider than a short list", () => {
    const c = { slots: ["morning", "evening"] as const, rooms: HOUSE_ROOMS, actions: [...actions] };
    expect(c.rooms.length * c.actions.length).toBeGreaterThan(40);
    const a = composeFloorRoutine(c, { slot: 0, place: 0, action: 0, company: 0, strength: 0 });
    const b = composeFloorRoutine(c, { slot: 0.99, place: 0.99, action: 0.99, company: 0.9, strength: 1 });
    expect(a).toMatchObject({ slot: "morning", company: "alone", source: "floor" });
    expect(b.slot).toBe("evening");
    expect(b.company).toBe("whoever");
    expect(b.strength).toBeLessThanOrEqual(0.9);
  });
});
