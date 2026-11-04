import { describe, it, expect } from "vitest";
import { activeWorseThanPassiveBeyondNoise, assertGradient, type GradientResult, type Status } from "../property/calibrationGradientShared";

/**
 * The gradient gate guards "active play is never WORSE than passive". Point-checking that over 6 seeds is a coin flip (measured at 60 seeds on plain main: passive reach 46/60 vs
 * active 45/60), so it now fails only when active is worse BEYOND two-proportion sampling noise (z = 1.28) — the same stance as the PO bands (#2026). A REAL gap still trips it.
 */
const res = (passive: Status[], active: Status[], pw: number[] = [], aw: number[] = []): GradientResult[] =>
  passive.map((p, i) => ({ seed: i + 1, passive: { status: p, won: pw.includes(i) }, active: { status: active[i]!, won: aw.includes(i) } }));

describe("activeWorseThanPassiveBeyondNoise", () => {
  it("a one-seed deficit over 6 seeds is noise; equal or better is fine", () => {
    expect(activeWorseThanPassiveBeyondNoise(6, 5, 6)).toBe(false);
    expect(activeWorseThanPassiveBeyondNoise(46, 45, 60)).toBe(false);
    expect(activeWorseThanPassiveBeyondNoise(3, 6, 6)).toBe(false);
  });
  it("a REAL gap trips it (6/6 vs 4/6; 6/6 vs 1/6; at scale 54/60 vs 40/60)", () => {
    expect(activeWorseThanPassiveBeyondNoise(6, 4, 6)).toBe(true);
    expect(activeWorseThanPassiveBeyondNoise(6, 1, 6)).toBe(true);
    expect(activeWorseThanPassiveBeyondNoise(54, 40, 60)).toBe(true);
  });
});

describe("assertGradient (the injected-expect band over 6 seeds)", () => {
  const J: Status = "jury", E: Status = "evicted";
  it("passes the live-CI shape that used to be a coin flip: passive 6/6 reach vs active 5/6, wins 0 vs 1", () => {
    expect(() => assertGradient(res([J, J, J, J, J, J], [J, J, J, J, E, J], [], [0]), expect as never)).not.toThrow();
  });
  it("still fails when active clearly reaches less often (6/6 vs 3/6) — a real regression is not hidden", () => {
    expect(() => assertGradient(res([J, J, J, J, J, J], [J, J, J, E, E, E]), expect as never)).toThrow();
  });
  it("still fails when passive clearly out-wins active (2 wins vs 0)", () => {
    expect(() => assertGradient(res([J, J, J, J, J, J], [J, J, J, J, J, J], [0, 1], []), expect as never)).toThrow();
  });
});
