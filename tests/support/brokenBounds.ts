/**
 * THE "GAME IS BROKEN" BOUNDS - the only social-mix and difficulty checks that fail a build (Ryne, 2026-11-26: "That check should stop. This is the same as the difficulty
 * balances. It doesn't make sense to arbitrarily hold everything to a standard for every single fix... social balancing and the difficulty balancing should be tested around
 * once a week and tracked rather than tweaked every time. Maybe let's come up with a super wide range for these that only don't pass if they break the game."; ORW-991).
 *
 * Everything else these lanes measure (the per-phase mix bands, the PO target bands, the gradient and jury-reach bands) is PRINTED as a report and tracked weekly
 * (.github/workflows/weekly-calibration.yml), never asserted. A bound here is "clearly broken, not just different": each carries its reason, and each sits well outside
 * what the noise measurements (ORW-944 mix noise, ORW-982 gradient, the 300-seed PO runs) have ever shown on a healthy main. Pure; no I/O.
 */

export const BROKEN = {
  /**
   * Social mix, per phase: a kind of scene (bonding / strategy / gossip / conflict) at 0% of a phase with enough scenes to read. A whole kind of house life is gone.
   * Healthy mains read conflict 4-10% and every other kind 12% or more, per phase, pooled.
   */
  socialKindGone: 0,
  /**
   * Social mix, per phase: one kind above this share of the phase's scenes. One activity has swallowed the house. Healthy pooled phases peak at about 50% (late gossip,
   * which swings +-11 with four seasons); single seasons have reached 62.5%. 75% is clearly broken, not a noisy late week.
   */
  socialOneKindSwallows: 75,
  /** Week-1 mix (12 seasons): every season reads the same mix to within this many points in every kind. The seasons stopped differing (the replayability mandate). */
  socialSeasonsIdentical: 1,
  /** PO arms: the solid player never wins, or never reaches the Final 2, across the whole sample. Playing well cannot win the game. */
  poSolidNeverWins: 0,
  /** PO arms: passive play out-wins solid play by more than this win-rate gap (5 points = 15 of 300 seasons). Doing nothing pays more than playing. Healthy mains read solid above passive. */
  poPassiveBeatsSolidBy: 0.05,
  /** Gradient: active play trails passive in jury reach by more than this share (25 points = 15 of 60 seasons). Healthy mains read active at or above passive. */
  gradientActiveTrailsBy: 0.25,
  /** Jury reach (passive): a passive player wins more than this share of the seasons. The house hands out the crown (healthy: a handful of 20, each earned). */
  juryPassiveWinsMostShare: 0.5,
} as const;

/** One kind's share per phase (percent), with the phase's scene count. */
export interface PhaseMix { n: number; bonding: number; strategy: number; gossip: number; conflict: number }
const KINDS = ["bonding", "strategy", "gossip", "conflict"] as const;

/** Every broken bound a phase mix hits (empty = not broken). `minScenes`: a phase with fewer scenes is not read (it is reported, not judged). */
export function socialBroken(phases: Readonly<Record<string, PhaseMix>>, minScenes: number): string[] {
  const out: string[] = [];
  for (const [phase, m] of Object.entries(phases)) {
    if (m.n <= minScenes) continue;
    for (const k of KINDS) {
      if (m[k] <= BROKEN.socialKindGone) out.push(`${phase}: no ${k} scenes at all (${m.n} scenes): a whole kind of house life is gone`);
      if (m[k] > BROKEN.socialOneKindSwallows) out.push(`${phase}: ${k} is ${m[k].toFixed(1)}% of ${m.n} scenes (over ${BROKEN.socialOneKindSwallows}%): one activity has swallowed the house`);
    }
  }
  return out;
}

/** Week-1 mix: broken when every season is the same mix (no kind spreads more than `socialSeasonsIdentical` points across the seasons). */
export function seasonsIdentical(spreadByKind: Readonly<Record<string, number>>): string[] {
  return Object.values(spreadByKind).every((s) => s <= BROKEN.socialSeasonsIdentical)
    ? [`every season reads the same week-1 mix (no kind spreads more than ${BROKEN.socialSeasonsIdentical} point): the seasons stopped differing`]
    : [];
}

/** PO arms: broken only when playing well cannot win, or doing nothing clearly pays more than playing. */
export function poBroken(s: { passive: { seasons: number; wins: number }; solid: { seasons: number; wins: number; reachedF2: number } }): string[] {
  const out: string[] = [];
  if (s.solid.wins <= BROKEN.poSolidNeverWins) out.push(`the solid player never won in ${s.solid.seasons} seasons: playing well cannot win`);
  if (s.solid.reachedF2 <= BROKEN.poSolidNeverWins) out.push(`the solid player never reached the Final 2 in ${s.solid.seasons} seasons`);
  const gap = s.passive.wins / s.passive.seasons - s.solid.wins / s.solid.seasons;
  if (gap > BROKEN.poPassiveBeatsSolidBy) out.push(`passive play out-wins solid by ${(100 * gap).toFixed(1)} points (over ${100 * BROKEN.poPassiveBeatsSolidBy}): doing nothing pays more than playing`);
  return out;
}

/** Gradient (passive vs minimal-active seasons): broken only when active play never reaches the jury, or trails passive by a wide margin. */
export function gradientBroken(passiveReach: number, activeReach: number, n: number): string[] {
  const out: string[] = [];
  if (activeReach === 0) out.push(`active play never reached the jury in ${n} seasons`);
  if ((passiveReach - activeReach) / n > BROKEN.gradientActiveTrailsBy) out.push(`active play reached the jury ${activeReach}/${n} against passive ${passiveReach}/${n} (trails by more than ${100 * BROKEN.gradientActiveTrailsBy} points)`);
  return out;
}

/** Jury reach (passive seasons): broken when nobody reaches the jury, nobody is ever evicted early, or a passive player wins most seasons. (Each crown being EARNED stays a hard check: anti-sycophancy, mandate #3.) */
export function juryBroken(reachedJury: number, evictedEarly: number, wins: number, n: number): string[] {
  const out: string[] = [];
  if (reachedJury === 0) out.push(`no passive season reached the jury in ${n}`);
  if (evictedEarly === 0) out.push(`no passive season was evicted before the jury in ${n}: the engine walks the player past the early weeks`);
  if (wins / n > BROKEN.juryPassiveWinsMostShare) out.push(`a passive player won ${wins} of ${n} seasons: the house hands out the crown`);
  return out;
}
