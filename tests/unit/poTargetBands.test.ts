import { describe, it, expect } from "vitest";
import { poViolations, type PoSummary } from "../calibration/poTargetBands";
import type { ArmSummary } from "../calibration/calibrationArms";

/** Synthetic 100-season summaries: the BAND LOGIC is what is under test (the heavy play is calibrationPoTarget.test.ts). */
const arm = (name: ArmSummary["arm"], f2: number, wins: number): ArmSummary =>
  ({ arm: name, seasons: 100, reachedF2: f2, wins } as unknown as ArmSummary);
const ON_TARGET: PoSummary = { passive: arm("passive", 11, 3), solid: arm("solid", 16, 8), reckless: arm("reckless", 5, 2) };

describe("PO calibration targets — the band checker (Ryne's 2026-11-02 rulings)", () => {
  it("an on-target season set has no violations", () => {
    expect(poViolations(ON_TARGET)).toEqual([]);
  });

  it("the measured 2026-11-03 default profile (solid 30% F2 / 13% win) is flagged on exactly the solid bands", () => {
    const measured: PoSummary = { passive: arm("passive", 11, 3), solid: arm("solid", 30, 13), reckless: arm("reckless", 5, 3) };
    const v = poViolations(measured);
    expect(v.length).toBe(2);
    expect(v[0]).toMatch(/solid reach-F2 30\.0% is outside 12\.0%-20\.0%/);
    expect(v[1]).toMatch(/solid win 13\.0% is outside 6\.0%-10\.0%/);
  });

  it("each band is individually enforced (edge cases)", () => {
    const at = (over: Partial<PoSummary>): string[] => poViolations({ ...ON_TARGET, ...over });
    expect(at({ passive: arm("passive", 16, 3) }).join()).toMatch(/passive reach-F2 16\.0%/);
    expect(at({ passive: arm("passive", 11, 5) }).join()).toMatch(/passive win 5\.0% is not under 5\.0%/);
    expect(at({ solid: arm("solid", 11, 8) }).join()).toMatch(/solid reach-F2 11\.0%/);
    expect(at({ solid: arm("solid", 21, 8) }).join()).toMatch(/solid reach-F2 21\.0%/);
    expect(at({ solid: arm("solid", 16, 5) }).join()).toMatch(/solid win 5\.0%/);
    expect(at({ solid: arm("solid", 16, 11) }).join()).toMatch(/solid win 11\.0%/);
    expect(at({ reckless: arm("reckless", 12, 2) }).join()).toMatch(/reckless reach-F2 12\.0% beats passive/);
    expect(at({ reckless: arm("reckless", 5, 4) }).join()).toMatch(/reckless win 4\.0% beats passive/);
  });

  it("active must CLEARLY beat passive (a tie is a violation)", () => {
    const v = poViolations({ passive: arm("passive", 12, 4), solid: arm("solid", 12, 6), reckless: arm("reckless", 5, 2) });
    expect(v.join()).toMatch(/does not clearly beat passive/);
  });

  it("the edges that the ruling includes are inclusive (solid exactly 12% / 20% F2 and 6% / 10% win pass)", () => {
    for (const [f2, w] of [[12, 6], [20, 10], [12, 10], [20, 6]] as const) {
      expect(poViolations({ ...ON_TARGET, solid: arm("solid", f2, w) }), `solid ${f2}/${w}`).toEqual([]);
    }
  });
});
