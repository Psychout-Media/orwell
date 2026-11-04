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

  it("the earlier retuned profile (300 seeds: solid 20.7% F2 / 5.0% win) passed the OLD 6-10% win band; under Ryne's 2026-11-03 8-12% win band its win rate is now (correctly) flagged", () => {
    const retuned: PoSummary = { passive: arm("passive", 32, 5), solid: arm("solid", 62, 15), reckless: arm("reckless", 9, 3) };
    const v = poViolations(retuned);
    expect(v.length).toBe(1);
    expect(v[0]).toMatch(/solid win 5\.0% is outside 8\.0%-12\.0%/);
  });

  it("the 300-seed gate run that opened the tracking issue (solid 12.7% win, reach in band) passes the 8-12% win band (Ryne 2026-11-03: ~60% conversion)", () => {
    const run: PoSummary = { passive: arm("passive", 22, 7), solid: arm("solid", 55, 38), reckless: arm("reckless", 9, 3) };
    expect(poViolations(run)).toEqual([]);
    // ...but the band is still enforced: a clearly-too-high solid win rate is flagged
    expect(poViolations({ ...run, solid: arm("solid", 55, 55) }).join()).toMatch(/solid win 18\.3% is outside 8\.0%-12\.0%/);
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

  it("reckless-vs-passive is judged beyond sampling noise: a one-win gap in a small count is tolerated, a real gap is not", () => {
    // the PO-gate run on #2023: passive 4 wins vs reckless 5 wins over 300 seasons each (a one-win gap) must NOT fail
    expect(poViolations({ ...ON_TARGET, passive: arm("passive", 26, 4), solid: arm("solid", 64, 19), reckless: arm("reckless", 9, 5) })).toEqual([]);
    // the SAME tolerance on reach-F2: a one-count gap (reckless 10 vs passive 9 of 300) passes, a real gap does not
    expect(poViolations({ ...ON_TARGET, passive: arm("passive", 9, 4), solid: arm("solid", 64, 19), reckless: arm("reckless", 10, 3) })).toEqual([]);
    expect(poViolations({ ...ON_TARGET, passive: arm("passive", 9, 4), solid: arm("solid", 64, 19), reckless: arm("reckless", 45, 3) }).join()).toMatch(/reckless reach-F2 15\.0% beats passive/);
    // ... while a real gap still does (the existing cases above: 15.0% vs 11.0% reach, 8.0% vs 3.0% wins)
    expect(poViolations({ ...ON_TARGET, reckless: arm("reckless", 9, 24) }).join()).toMatch(/reckless win 8\.0% beats passive/);
  });

  it("sampling error is tolerated, not ignored: a point estimate just outside a band passes, a clear miss does not, and a small sample widens the interval", () => {
    // solid 21.7% F2 (65/300) is outside 12-20% by point estimate but inside its 80% interval ...
    expect(poViolations({ ...ON_TARGET, solid: arm("solid", 65, 21) })).toEqual([]);
    // ... while at n=300 a 26% reach is a clear miss ...
    expect(poViolations({ ...ON_TARGET, solid: arm("solid", 78, 21) }).join()).toMatch(/solid reach-F2 26\.0%/);
    // ... but the SAME 26.7% rate over only 30 seasons is within its (much wider) interval, so it is tolerated.
    expect(poViolations({ ...ON_TARGET, solid: arm("solid", 8, 2, 30) })).toEqual([]);
    expect(PO_Z).toBeGreaterThan(1);
  });

  it("active must CLEARLY beat passive (a tie is a violation)", () => {
    const v = poViolations({ passive: arm("passive", 48, 21), solid: arm("solid", 48, 21), reckless: arm("reckless", 9, 3) });
    expect(v.join()).toMatch(/does not clearly beat passive/);
  });
});
