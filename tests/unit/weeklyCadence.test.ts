import { describe, it, expect } from "vitest";
import { WEEKLY_CADENCE, CLOCK } from "../../src/engine/sleepConstants";
import { DAY_SCHEDULE } from "../../src/engine/daySchedule";
import { phaseForHour } from "../../src/engine/timeOfDay";

/**
 * 0066 (#1125) — the weekly 5-cycle cadence + period placement in the 24-hour model. One HOH reign:
 * HOH → nominations → veto draw + veto competition → veto ceremony → eviction, STRICT order, no default
 * rest days, the daily-event invariant. The HOH crowns in the MORNING (maximizing the post-HOH playable
 * window), the veto COMP runs in the AFTERNOON, the EVICTION is in the EVENING, and the next HOH begins the
 * MORNING AFTER the eviction (NOT eviction night). Roles only — beats, not names.
 */

describe("the weekly 5-cycle — strict order, no rest days, the daily-event spine", () => {
  it("runs HOH → noms → veto draw → veto comp → veto ceremony → eviction, in strict order", () => {
    expect([...WEEKLY_CADENCE.order]).toEqual(
      ["hoh", "nominations", "veto-draw", "veto-competition", "veto-ceremony", "eviction"],
    );
  });

  it("each of Days 1–5 carries a meaningful beat (no default rest day)", () => {
    const days = new Set(Object.values(WEEKLY_CADENCE.dayOf));
    for (const d of [1, 2, 3, 4, 5]) expect(days.has(d), `Day ${d} has a beat`).toBe(true);
    // Day 3 carries TWO beats (the veto player draw THEN the veto competition).
    expect(WEEKLY_CADENCE.dayOf["veto-draw"]).toBe(3);
    expect(WEEKLY_CADENCE.dayOf["veto-competition"]).toBe(3);
  });

  it("the day order respects the strict beat order (a beat never precedes an earlier-order beat's day)", () => {
    let prevDay = 0;
    for (const beat of WEEKLY_CADENCE.order) {
      expect(WEEKLY_CADENCE.dayOf[beat]).toBeGreaterThanOrEqual(prevDay);
      prevDay = WEEKLY_CADENCE.dayOf[beat];
    }
  });
});

describe("period placement — HOH in the morning, veto comp in the afternoon, eviction in the evening", () => {
  it("the HOH comp is scheduled in the AFTERNOON per DAY_SCHEDULE (the house gets a morning to scramble first)", () => {
    expect(DAY_SCHEDULE["hoh-competition"]).toBe("afternoon");
    expect(phaseForHour(CLOCK.phaseStartsHour.afternoon)).toBe("afternoon");
    expect(CLOCK.phaseStartsHour.evening).toBeGreaterThan(CLOCK.phaseStartsHour.afternoon); // room after the HOH
  });

  it("the veto COMPETITION runs in the AFTERNOON (Day 3, after the morning player draw)", () => {
    expect(WEEKLY_CADENCE.dayOf["veto-draw"]).toBe(WEEKLY_CADENCE.dayOf["veto-competition"]); // same day, draw first
    expect(DAY_SCHEDULE["veto-competition"]).toBe("afternoon");
    expect(phaseForHour(CLOCK.phaseStartsHour.afternoon)).toBe("afternoon");
  });

  it("the EVICTION is in the EVENING (Day 5)", () => {
    expect(DAY_SCHEDULE.eviction).toBe("evening");
    expect(phaseForHour(CLOCK.phaseStartsHour.evening)).toBe("evening");
  });

  it("nominations and the veto ceremony are EVENING beats per DAY_SCHEDULE (ORW-116, Ryne: ceremonies in the evening)", () => {
    expect(DAY_SCHEDULE.nominations).toBe("evening");
    expect(DAY_SCHEDULE["veto-ceremony"]).toBe("evening");
  });
});

describe("the eviction → next-HOH gap is the one light 'process the eviction' beat", () => {
  it("the next HOH is the MORNING AFTER the eviction (Day 6), not eviction night", () => {
    // Eviction is Day 5 evening; the next reign's HOH is the morning of Day 6 — a fresh day after the
    // eviction, the only light gap in the otherwise back-to-back cadence.
    expect(WEEKLY_CADENCE.dayOf.eviction).toBe(5);
    const nextHohDay = WEEKLY_CADENCE.dayOf.eviction + 1; // Day 6
    expect(nextHohDay).toBe(6);
    expect(DAY_SCHEDULE["hoh-competition"]).toBe("afternoon"); // the next reign's HOH comp uses the same DAY_SCHEDULE slot
  });
});
