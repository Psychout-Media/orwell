import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PO_BANDS } from "../../tests/calibration/poTargetBands";

/** The nightly calibration workflow's summary-table footer restates the PO bands in prose; it drifted once (said "win 6-10%" after the band moved to 8-12%). Pin the footer to PO_BANDS. */
describe("calibration-nightly summary footer states the real PO bands", () => {
  const wf = readFileSync(".github/workflows/calibration-nightly.yml", "utf8");
  const pct = (x: number): string => String(Math.round(x * 100));
  it("passive and solid bands match poTargetBands.ts", () => {
    expect(wf).toContain(`passive F2 <= ${pct(PO_BANDS.passive.f2Max)}%, win < ${pct(PO_BANDS.passive.winBelow)}%`);
    expect(wf).toContain(`solid F2 ${pct(PO_BANDS.solid.f2Min)}-${pct(PO_BANDS.solid.f2Max)}%, win ${pct(PO_BANDS.solid.winMin)}-${pct(PO_BANDS.solid.winMax)}%`);
  });
});
