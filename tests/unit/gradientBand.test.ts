import { describe, it, expect } from "vitest";
import { activeWorseThanPassiveBeyondNoise, assertGradient, SEEDS, type GradientResult, type Status } from "../property/calibrationGradientShared";

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

describe("assertGradient (the injected-expect band over SEEDS seeds)", () => {
  const J: Status = "jury", E: Status = "evicted";
  // ORW-982: the gate reads SEEDS (60) seeds. A 6-seed pattern is repeated to SEEDS (the same proportions); the noise case is one seed out of SEEDS.
  const times = <T>(xs: T[]): T[] => Array.from({ length: SEEDS }, (_, i) => xs[i % xs.length]!);
  const at = (idx: number[]): number[] => Array.from({ length: SEEDS }, (_, i) => i).filter((i) => idx.includes(i % 6));
  it("passes a one-seed miss and a one-win edge (noise, the live shape that used to be a coin flip)", () => {
    const active: Status[] = times<Status>([J]); active[4] = E;
    expect(() => assertGradient(res(times([J]), active, [], [0]), expect as never)).not.toThrow();
  });
  it("still fails when active clearly reaches less often (6/6 vs 3/6, repeated) — a real regression is not hidden", () => {
    expect(() => assertGradient(res(times([J, J, J, J, J, J]), times([J, J, J, E, E, E])), expect as never)).toThrow();
  });
  it("still fails when passive clearly out-wins active (2 wins vs 0 in every 6, repeated)", () => {
    expect(() => assertGradient(res(times([J, J, J, J, J, J]), times([J, J, J, J, J, J]), at([0, 1]), []), expect as never)).toThrow();
  });
});
