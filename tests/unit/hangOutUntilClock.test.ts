import { describe, it, expect } from "vitest";
import { minutesUntilClock } from "../../src/engine/hangOut";

/**
 * ORW-734a: "wait until <clock time>". The player's stated clock time becomes a minutes target measured on the engine's own clock (8..32 day scale, an early-morning wake reads 0..8).
 * The NEXT such time, never a day later: a time already passed today is 0 (nothing to wait). Roles only.
 */
describe("minutesUntilClock", () => {
  it("evening to a later evening time", () => { expect(minutesUntilClock(19 + 25 / 60, 22)).toBeCloseTo(155, 6); });
  it("a half-hour time", () => { expect(minutesUntilClock(21, 22.5)).toBeCloseTo(90, 6); });
  it("a time already passed today is zero, never tomorrow's", () => { expect(minutesUntilClock(23, 22)).toBe(0); expect(minutesUntilClock(22, 22)).toBe(0); });
  it("after midnight on the day scale (hour 24+) reaches the small hours", () => { expect(minutesUntilClock(23, 1)).toBeCloseTo(120, 6); expect(minutesUntilClock(25, 1)).toBe(0); });
  it("the wake-up hour is the NEXT morning from the day's own evening", () => { expect(minutesUntilClock(31, 8)).toBeCloseTo(60, 6); expect(minutesUntilClock(8.5, 8)).toBeCloseTo(23.5 * 60, 6); });
  it("an early-morning wake reads 0..8: the target is later that morning", () => { expect(minutesUntilClock(4, 8)).toBeCloseTo(240, 6); expect(minutesUntilClock(4, 6.5)).toBeCloseTo(150, 6); expect(minutesUntilClock(6, 5)).toBe(0); });
  it("an invalid hour is no target", () => { expect(minutesUntilClock(20, Number.NaN)).toBeNull(); expect(minutesUntilClock(20, 25)).toBeNull(); expect(minutesUntilClock(20, -1)).toBeNull(); });
});
