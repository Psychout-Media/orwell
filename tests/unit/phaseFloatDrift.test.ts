import { describe, it, expect } from "vitest";
import { phaseForHour, formatClockLabel } from "../../src/engine/timeOfDay";
import { advanceClockPerMessage } from "../../src/engine/liveSeason";

describe("ORW-445: the public phase agrees with the clock label across float drift", () => {
  it("a clock that prints as an edge reads as that phase", () => {
    expect(phaseForHour(12 - 1e-9)).toBe("afternoon");
    expect(phaseForHour(16 - 1e-9)).toBe("evening");
    expect(phaseForHour(20 - 1e-9)).toBe("night");
    expect(phaseForHour(11.99)).toBe("morning");
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
