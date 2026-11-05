import type { ArmSummary } from "./calibrationArms";

/**
 * The PO calibration TARGETS as executable bands (docs/decisions/PO-DECISIONS-LOG.md, 2026-11-02 "Difficulty"):
 *   - PASSIVE - reach F2 about 5-10% (the owner ACCEPTS up to ~13-15% as the realistic "goat" effect), win UNDER 5%.
 *   - SOLID (a steady, sensible social game; the "active smart" target, amended "a tad harder") - reach F2 12-20%, win 8-12%.
 *     The WIN band moved from 6-10% to 8-12% per Ryne's 2026-11-03 ruling ("a good player usually wins, ~60% conversion; reach stays 12-20%; solid wins ~8-12%;
 *     the PO gate's win band must follow"); reach is unchanged. The band update was meant to ride on the jury retune, which became design-only, so it lands here.
 *   - RECKLESS - bad strategy must not beat doing nothing: F2 rate and wins no higher than passive.
 *   - Active must CLEARLY beat passive: solid F2 and wins strictly above passive.
 * SAMPLING: a rate measured over n seasons is a binomial estimate (n=300, an 8% rate has an SE of about 1.6 points), and the owner's
 * targets are "about" numbers. A band is therefore violated only when it lies OUTSIDE the measured rate's confidence interval
 * (`PO_Z` = 1.28, an 80% two-sided interval): a point estimate at the edge is not a failure, but a real drift (e.g. solid reach at 29%) is.
 * Pure (no I/O) so the band logic itself is unit-tested (tests/unit/poTargetBands.test.ts); the heavy play lives in
 * calibrationPoTarget.test.ts. Roles only.
 */
/** The ONE home of the bands (S15 / AMEND card 21): nothing else - no doc, test or workflow text - may restate the numbers; `poBandsFooter()` renders them for the CI summary. */
export const PO_BANDS_STAMP = {
  ruledBy: "Ryne (PO)",
  date: "2026-11-03",
  source: "docs/decisions/PO-DECISIONS-LOG.md 2026-11-02 'Difficulty' (passive F2 5-10%, win <5%; reckless not above passive; solid above passive) + 2026-11-03 win-band ruling (solid win 8-12%, #2073)",
} as const;

export const PO_BANDS = {
  passive: { f2Max: 0.15, winBelow: 0.05 },
  solid: { f2Min: 0.12, f2Max: 0.2, winMin: 0.08, winMax: 0.12 },
} as const;

export interface PoSummary { passive: ArmSummary; solid: ArmSummary; reckless: ArmSummary }

/** Two-sided normal z for the sampling interval (1.28 = 80%). */
export const PO_Z = 1.28;

/** The [lo, hi] interval of a measured rate k/n (normal approximation; clamped to [0,1]). */
function interval(k: number, n: number, z: number): [number, number] {
  const p = k / n;
  const se = Math.sqrt((p * (1 - p)) / n);
  return [Math.max(0, p - z * se), Math.min(1, p + z * se)];
}

/**
 * True when rate A (kA/nA) exceeds rate B (kB/nB) by MORE than the sampling noise of their difference (two-proportion SE x z).
 * "Reckless must be no better than passive" is a claim about two small, noisy rates (e.g. 5 vs 4 wins in 300); a one-win gap is not a
 * regression. Same sampling stance as the bands above: only a real, outside-the-noise difference is a failure.
 */
function beatsBeyondNoise(kA: number, nA: number, kB: number, nB: number, z: number): boolean {
  const pA = kA / nA, pB = kB / nB;
  const se = Math.sqrt((pA * (1 - pA)) / nA + (pB * (1 - pB)) / nB);
  return pA - pB > z * se;
}

/** Every violated band, as a plain sentence (empty => all PO targets hold within sampling error). */
export function poViolations(s: PoSummary, z: number = PO_Z): string[] {
  const out: string[] = [];
  const pc = (x: number): string => `${(100 * x).toFixed(1)}%`;
  const f2 = (a: ArmSummary): [number, number] => interval(a.reachedF2, a.seasons, z);
  const win = (a: ArmSummary): [number, number] => interval(a.wins, a.seasons, z);
  const pt = (a: ArmSummary): { f2: number; win: number } => ({ f2: a.reachedF2 / a.seasons, win: a.wins / a.seasons });
  const p = pt(s.passive), so = pt(s.solid), re = pt(s.reckless);
  // passive: reach not above the accepted ceiling; win under 5%  (violated only if the WHOLE interval is on the wrong side)
  if (f2(s.passive)[0] > PO_BANDS.passive.f2Max) out.push(`passive reach-F2 ${pc(p.f2)} is above the accepted ${pc(PO_BANDS.passive.f2Max)}`);
  if (win(s.passive)[0] >= PO_BANDS.passive.winBelow) out.push(`passive win ${pc(p.win)} is not under ${pc(PO_BANDS.passive.winBelow)}`);
  // solid: the band must intersect the measured interval
  const B = PO_BANDS.solid;
  const [f2lo, f2hi] = f2(s.solid);
  if (f2hi < B.f2Min || f2lo > B.f2Max) out.push(`solid reach-F2 ${pc(so.f2)} is outside ${pc(B.f2Min)}-${pc(B.f2Max)}`);
  const [wlo, whi] = win(s.solid);
  if (whi < B.winMin || wlo > B.winMax) out.push(`solid win ${pc(so.win)} is outside ${pc(B.winMin)}-${pc(B.winMax)}`);
  // ordering claims: solid "clearly beats" passive on the point estimates (strict); reckless must not beat passive BEYOND SAMPLING NOISE
  if (!(so.f2 > p.f2)) out.push(`solid reach-F2 ${pc(so.f2)} does not clearly beat passive ${pc(p.f2)}`);
  if (!(so.win > p.win)) out.push(`solid win ${pc(so.win)} does not clearly beat passive ${pc(p.win)}`);
  if (beatsBeyondNoise(s.reckless.reachedF2, s.reckless.seasons, s.passive.reachedF2, s.passive.seasons, z)) out.push(`reckless reach-F2 ${pc(re.f2)} beats passive ${pc(p.f2)}`);
  if (beatsBeyondNoise(s.reckless.wins, s.reckless.seasons, s.passive.wins, s.passive.seasons, z)) out.push(`reckless win ${pc(re.win)} beats passive ${pc(p.win)}`);
  return out;
}

const pctOf = (x: number): string => String(Math.round(x * 100));
/** The CI summary footer, generated from PO_BANDS so a stale band can never be restated in prose. */
export function poBandsFooter(): string {
  const { passive, solid } = PO_BANDS;
  return `Targets (${PO_BANDS_STAMP.ruledBy}, ${PO_BANDS_STAMP.date}): passive F2 <= ${pctOf(passive.f2Max)}%, win < ${pctOf(passive.winBelow)}%; solid F2 ${pctOf(solid.f2Min)}-${pctOf(solid.f2Max)}%, win ${pctOf(solid.winMin)}-${pctOf(solid.winMax)}%; reckless no better than passive. Source: ${PO_BANDS_STAMP.source}`;
}
