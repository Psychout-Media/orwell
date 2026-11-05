import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PO_BANDS, PO_BANDS_STAMP, poBandsFooter } from "../../tests/calibration/poTargetBands";

/** S15 item 1 - the PO bands live in ONE stamped file. The nightly/weekly workflow must not restate them (it once said "win 6-10%" after the band moved to 8-12%); its summary footer is GENERATED from PO_BANDS. */
describe("calibration workflow carries no copy of the PO bands", () => {
  const wf = readFileSync(".github/workflows/calibration-nightly.yml", "utf8");
  it("the workflow has no hard-coded band prose and renders the footer from poTargetBands.ts", () => {
    expect(wf).not.toMatch(/passive F2\s*<=/);
    expect(wf).not.toMatch(/solid F2\s*\d/);
    expect(wf).toContain("poBandsFooter");
  });
  it("the generated footer states the real bands, the ruling date and the source", () => {
    const f = poBandsFooter();
    const pct = (x: number): string => String(Math.round(x * 100));
    expect(f).toContain(`passive F2 <= ${pct(PO_BANDS.passive.f2Max)}%, win < ${pct(PO_BANDS.passive.winBelow)}%`);
    expect(f).toContain(`solid F2 ${pct(PO_BANDS.solid.f2Min)}-${pct(PO_BANDS.solid.f2Max)}%, win ${pct(PO_BANDS.solid.winMin)}-${pct(PO_BANDS.solid.winMax)}%`);
    expect(f).toContain(PO_BANDS_STAMP.date);
    expect(f).toContain(PO_BANDS_STAMP.source);
  });
});

/** The cadence (card 21): weekly + on demand + PRs that touch tuning constants or default flags; the tracking issue is never opened from a PR run. */
describe("calibration workflow cadence and triggers", () => {
  const wf = readFileSync(".github/workflows/calibration-nightly.yml", "utf8");
  it("is weekly (not daily) with dispatch and a path-filtered pull_request trigger", () => {
    expect(wf).toMatch(/cron: "17 3 \* \* 1"/);
    expect(wf).toContain("workflow_dispatch:");
    expect(wf).toContain("pull_request:");
    for (const p of ["temperatureConstants", "relationshipConstants", "decisionConstants", "juryConstants", "flagDefaults", "featureFlags", "orwell-env-defaults"]) expect(wf).toContain(p);
  });
  it("only scheduled/dispatch runs open the tracking issue", () => {
    expect(wf).toMatch(/if: failure\(\) && github\.event_name != 'pull_request'/);
  });
});
