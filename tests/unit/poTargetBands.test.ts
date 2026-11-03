import { describe, it, expect } from "vitest";
import { poViolations, PO_Z, type PoSummary } from "../calibration/poTargetBands";
import type { ArmSummary } from "../calibration/calibrationArms";

/** Synthetic 300-season summaries: the BAND LOGIC is what is under test (the heavy play is calibrationPoTarget.test.ts). */
const N = 300;
const arm = (name: ArmSummary["arm"], f2: number, wins: number, n = N): ArmSummary =>
  ({ arm: name, seasons: n, reachedF2: f2, wins } as unknown as ArmSummary);
const ON_TARGET: PoSummary = { passive: arm("passive", 33, 9), solid: arm("solid", 48, 21), reckless: arm("reckless", 9, 3) };

describe("PO calibration targets — the band checker (Ryne's 2026-11-02 rulings, with sampling tolerance)", () => {
  it("an on-target season set has no violations", () => {
    expect(poViolations(ON_TARGET)).toEqual([]);
  });

  it("the measured retuned profile (300 seeds: solid 20.7% F2 / 5.0% win — at the band edges) passes within sampling error", () => {
    const retuned: PoSummary = { passive: arm("passive", 32, 5), solid: arm("solid", 62, 15), reckless: arm("reckless", 9, 3) };
    expect(poViolations(retuned)).toEqual([]);
  });

  it("the pre-retune default (300 seeds: solid 29.0% F2 / 9.7% win) is flagged on exactly solid reach", () => {
    const before: PoSummary = { passive: arm("passive", 32, 7), solid: arm("solid", 87, 29), reckless: arm("reckless", 12, 5) };
    const v = poViolations(before);
    expect(v.length).toBe(1);
    expect(v[0]).toMatch(/solid reach-F2 29\.0% is outside 12\.0%-20\.0%/);
  });

  it("each band is individually enforced when the WHOLE interval is on the wrong side", () => {
    const at = (over: Partial<PoSummary>): string => poViolations({ ...ON_TARGET, ...over }).join("|");
    expect(at({ passive: arm("passive", 60, 9) })).toMatch(/passive reach-F2 20\.0%/);
    expect(at({ passive: arm("passive", 33, 27) })).toMatch(/passive win 9\.0% is not under 5\.0%/);
    expect(at({ solid: arm("solid", 21, 21) })).toMatch(/solid reach-F2 7\.0%/);
    expect(at({ solid: arm("solid", 100, 21) })).toMatch(/solid reach-F2 33\.3%/);
    expect(at({ solid: arm("solid", 48, 6) })).toMatch(/solid win 2\.0%/);
    expect(at({ solid: arm("solid", 48, 45) })).toMatch(/solid win 15\.0%/);
    expect(at({ reckless: arm("reckless", 45, 3) })).toMatch(/reckless reach-F2 15\.0% beats passive/);
    expect(at({ reckless: arm("reckless", 9, 24) })).toMatch(/reckless win 8\.0% beats passive/);
  });

  it("sampling error is tolerated, not ignored: a point estimate just outside a band passes, a clear miss does not", () => {
    // solid 21.7% F2 (65/300) is outside 12-20% by point estimate but inside its 80% interval ...
    expect(poViolations({ ...ON_TARGET, solid: arm("solid", 65, 21) })).toEqual([]);
    // ... and the same rate over a tiny sample is of course tolerated too, while at n=300 a 26% reach is not.
    expect(poViolations({ ...ON_TARGET, solid: arm("solid", 78, 21) }).join()).toMatch(/solid reach-F2 26\.0%/);
    expect(PO_Z).toBeGreaterThan(1);
  });

  it("active must CLEARLY beat passive (a tie is a violation)", () => {
    const v = poViolations({ passive: arm("passive", 48, 21), solid: arm("solid", 48, 21), reckless: arm("reckless", 9, 3) });
    expect(v.join()).toMatch(/does not clearly beat passive/);
  });
});
