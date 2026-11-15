import { describe, it, expect } from "vitest";
import { phaseForHour, formatClockLabel } from "../../src/engine/timeOfDay";
import { milestoneDue } from "../../src/engine/daySchedule";
import { advanceClockPerMessage } from "../../src/engine/liveSeason";

describe("ORW-445: the public phase agrees with the clock label across float drift", () => {
  // An explicit expected-phase map (NOT phaseForHour as its own oracle): the edges and the float neighbourhood on each side.
  // Within 1e-6h BELOW an edge the clock has reached it (float drift); beyond 1e-6h it has not.
  const EDGES: Array<[number, string]> = [
    [8, "morning"], [8 + 1e-3, "morning"],
    [12 - 1e-3, "morning"], [12 - 2e-6, "morning"], [12 - 0.75e-6, "afternoon"], [12 - 1e-9, "afternoon"], [12, "afternoon"],
    [16 - 1e-3, "afternoon"], [16 - 2e-6, "afternoon"], [16 - 0.75e-6, "evening"], [16 - 1e-9, "evening"], [16, "evening"],
    [20 - 1e-3, "evening"], [20 - 2e-6, "evening"], [20 - 0.75e-6, "night"], [20 - 1e-9, "night"], [20, "night"],
    [24 - 1e-3, "night"], [24 - 2e-6, "night"], [24 - 0.75e-6, "late-night"], [24 - 1e-9, "late-night"], [24, "late-night"],
    [31.9999, "late-night"], [32, "late-night"],
  ];
  it.each(EDGES)("the explicit edge map: hour %s reads as %s", (hour, phase) => {
    expect(phaseForHour(hour)).toBe(phase);
  });
  it("phase and milestoneDue agree at every edge: due exactly when the phase has reached the milestone's phase", () => {
    const ORDER = ["morning", "afternoon", "evening", "night", "late-night"];
    const MILESTONES: Array<[string, string]> = [["hoh-competition", "afternoon"], ["nominations", "evening"]];
    for (const [beat, target] of MILESTONES) {
      for (const [hour] of EDGES) {
        const live: any = { beat, timeOfDay: phaseForHour(hour), nightDepth: hour, dayNumber: 3, week: 2, firstNightPassed: true, preHohNightPassed: true, preNomsNightPassed: true };
        expect(milestoneDue(live), `${beat} at ${hour}`).toBe(ORDER.indexOf(phaseForHour(hour)) >= ORDER.indexOf(target));
      }
    }
  });
  it("per-message 5-minute accrual never lands the label on an edge with the phase a band behind", () => {
    for (const startMin of [8 * 60, 8 * 60 + 2, 9 * 60 + 7]) {
      const s: any = { nightDepth: startMin / 60, timeOfDay: "morning", dayNumber: 1, finished: false };
      for (let i = 0; i < 200 && s.nightDepth < 31; i++) {
        advanceClockPerMessage(s, 5 / 60);
        const label = formatClockLabel(s.nightDepth);
        const m = /^(\d+):(\d\d)(am|pm)/.exec(label)!;
        let h = (Number(m[1]) % 12) + (m[3] === "pm" ? 12 : 0);
        if (s.nightDepth >= 24) h += 24;
        if (m[2] === "00" && [12, 16, 20, 24].includes(h)) expect(s.timeOfDay).toBe(phaseForHour(h));
      }
    }
  });
});
