/**
 * B5 / #2017 slice 1 (design S3) - VOTE COUNTING. An NPC estimates the upcoming eviction from its PERCEIVED reads of the other voters, with error scaled by `overconfidence`
 * (0..1): a confident NPC has NARROW error bars and SYSTEMATICALLY under-estimates dissent (it reads people as more on its side than they are), so it can be blindsided; an
 * unsure one has wide error bars and no bias. The believed margin gates campaigning (`inDoubt`): campaign only when the count is close. Pure and deterministic - the caller
 * supplies the seeded per-voter noise draws in [-1, 1] (a DEDICATED sub-rng, never the shared stream). The estimate is the estimator's private belief and is never projected.
 * Wiring into the campaign layer is slice 2, flag-off.
 */
export const VOTE_ESTIMATE = {
  /** Max error (probability points) at overconfidence 0; scaled by (1 - overconfidence). */
  errMax: 0.25,
  /** How far an overconfident estimator pulls each voter toward "agrees with me" (fraction of the remaining gap at overconfidence 1). */
  dissentBias: 0.35,
  /** Campaign only while the believed margin (votes) is within +/- (doubtBand + doubtPerVoter x voters) of the majority line - the band grows with the house so a normal-sized
   *  house's accumulated bias/noise does not push every count out of doubt. */
  doubtBand: 1.0,
  doubtPerVoter: 0.15,
} as const;

const clamp01 = (x: number): number => (Number.isNaN(x) ? 0 : Math.max(0, Math.min(1, x)));

/** The estimator's perceived P(this voter votes to evict the target), given the truth `p`, its overconfidence, and a seeded noise draw in [-1, 1]. */
export function perceivedSupport(p: number, overconfidence: number, noise: number): number {
  const oc = clamp01(overconfidence);
  const base = clamp01(p);
  const biased = base + oc * VOTE_ESTIMATE.dissentBias * (1 - base);
  return clamp01(biased + Math.max(-1, Math.min(1, noise)) * VOTE_ESTIMATE.errMax * (1 - oc));
}

/** The believed margin: expected believed votes to evict minus the majority line (n / 2). Positive => the estimator believes the target goes. */
export function believedMargin(trueSupport: readonly number[], overconfidence: number, noise: readonly number[]): number {
  let votes = 0;
  for (let i = 0; i < trueSupport.length; i++) votes += perceivedSupport(trueSupport[i]!, overconfidence, noise[i] ?? 0);
  return votes - trueSupport.length / 2;
}

/** Is the count close enough that the estimator still works the house? */
export function inDoubt(margin: number, voters = 0): boolean {
  return Math.abs(margin) <= VOTE_ESTIMATE.doubtBand + VOTE_ESTIMATE.doubtPerVoter * Math.max(0, voters);
}
