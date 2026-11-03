import type { ArmSummary } from "./calibrationArms";

/**
 * The PO calibration TARGETS as executable bands (docs/decisions/PO-DECISIONS-LOG.md, 2026-11-02 "Difficulty"):
 *   • PASSIVE — reach F2 about 5-10% (the owner ACCEPTS up to ~13-15% as the realistic "goat" effect), win UNDER 5%.
 *   • SOLID (a steady, sensible social game; the "active smart" target, amended "a tad harder") — reach F2 12-20%, win 6-10%.
 *   • RECKLESS — bad strategy must not beat doing nothing: F2 rate and wins no higher than passive.
 *   • Active must CLEARLY beat passive: solid F2 and wins strictly above passive.
 * Pure (no I/O) so the band logic itself is unit-tested (tests/unit/poTargetBands.test.ts); the heavy play lives in
 * calibrationPoTarget.test.ts. At n=100 one binomial SD is ~3-4 points, so the bands are exact per the ruling but the seeded
 * runs are deterministic: a failure is a real behavior change, never noise. Roles only.
 */
export const PO_BANDS = {
  passive: { f2Max: 0.15, winBelow: 0.05 },
  solid: { f2Min: 0.12, f2Max: 0.2, winMin: 0.06, winMax: 0.1 },
} as const;

export interface PoSummary { passive: ArmSummary; solid: ArmSummary; reckless: ArmSummary }

/** Every violated band, as a plain sentence (empty ⇒ all PO targets hold). */
export function poViolations(s: PoSummary): string[] {
  const out: string[] = [];
  const r = (a: ArmSummary): { f2: number; win: number } => ({ f2: a.reachedF2 / a.seasons, win: a.wins / a.seasons });
  const p = r(s.passive), so = r(s.solid), re = r(s.reckless);
  const pc = (x: number): string => `${(100 * x).toFixed(1)}%`;
  if (p.f2 > PO_BANDS.passive.f2Max) out.push(`passive reach-F2 ${pc(p.f2)} is above the accepted ${pc(PO_BANDS.passive.f2Max)}`);
  if (!(p.win < PO_BANDS.passive.winBelow)) out.push(`passive win ${pc(p.win)} is not under ${pc(PO_BANDS.passive.winBelow)}`);
  const B = PO_BANDS.solid;
  if (so.f2 < B.f2Min || so.f2 > B.f2Max) out.push(`solid reach-F2 ${pc(so.f2)} is outside ${pc(B.f2Min)}-${pc(B.f2Max)}`);
  if (so.win < B.winMin || so.win > B.winMax) out.push(`solid win ${pc(so.win)} is outside ${pc(B.winMin)}-${pc(B.winMax)}`);
  if (!(so.f2 > p.f2)) out.push(`solid reach-F2 ${pc(so.f2)} does not clearly beat passive ${pc(p.f2)}`);
  if (!(so.win > p.win)) out.push(`solid win ${pc(so.win)} does not clearly beat passive ${pc(p.win)}`);
  if (re.f2 > p.f2) out.push(`reckless reach-F2 ${pc(re.f2)} beats passive ${pc(p.f2)}`);
  if (re.win > p.win) out.push(`reckless win ${pc(re.win)} beats passive ${pc(p.win)}`);
  return out;
}
