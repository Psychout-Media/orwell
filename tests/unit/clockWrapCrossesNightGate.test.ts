import { describe, it, expect } from "vitest";
import { advanceClock, nightBreakPending, nightHeld, type LiveSeasonState } from "../../src/engine/liveSeason";
import { DAY_END_HOUR } from "../../src/engine/timeOfDay";

/** ORW-481 (review of the night gate): when the clock itself rolls the day (a late event pushes it past 8am), the pending night gate counts as crossed, so the next ceremony is not held behind a second night. Roles only. */
const at = (beat: string, clockInteractive: boolean): LiveSeasonState =>
  ({ week: 2, beat, clockInteractive, nightDepth: DAY_END_HOUR - 1, dayNumber: 3, timeOfDay: "late-night", nightTurns: 1 } as unknown as LiveSeasonState);

describe("a clock-rolled morning crosses the pending night gate", () => {
  it("a played game: the wrap marks the gate, the next ceremony is not held", () => {
    const s = at("nominations", true);
    expect(nightBreakPending(s)).toBe(true);
    advanceClock(s, 3);
    expect(s.dayNumber).toBe(4);
    expect(nightBreakPending(s), "the night was crossed by the clock itself").toBe(false);
    expect(s.preNomsNightPassed).toBe(true);
    expect(nightHeld(s) && nightBreakPending(s)).toBe(false);
  });
  it("a headless clock-live run keeps its trajectory (the gate is left for the day-break beat)", () => {
    const s = at("nominations", false);
    advanceClock(s, 3);
    expect(s.dayNumber).toBe(4);
    expect(nightBreakPending(s)).toBe(true);
  });
  it("a wrap that is not at a night-gate beat marks nothing", () => {
    const s = at("complete", true);
    advanceClock(s, 3);
    expect(s.preNomsNightPassed).toBeUndefined();
  });
});
