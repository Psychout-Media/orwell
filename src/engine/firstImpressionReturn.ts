/**
 * ORW-1080 (Ryne 2026-11-26: "first impressions that come back"). A houseguest who walked in with a strong read of the player has it return to them later: either it held or they were wrong. They say it (the
 * narrator voices it from a closed pair of facts, never the sealed clause or a number) and it moves their own view a little, so it reaches what they decide. Pure; no draw of its own.
 */
export const FIRST_RETURN = {
  /** Not before this in-game day: a first impression cannot "come back" while it is still the first week. */
  fromDay: 10,
  /** The day-one lean (trust + affinity, absolute) that counts as having taken a real view at all. */
  strongLean: 0.35,
  /** The chance one comes back on a given night (one at most). */
  chance: 0.35,
  /** Days the houseguest can be heard to say it. */
  voicedDays: 2,
  held: { trust: 0.04, affinity: 0.04 },
  overturned: { trust: 0.05, affinity: 0.05 },
} as const;

export interface FirstReturn { took: "warm" | "wary"; held: boolean }

/** The day-one lean against how they see the player now (`baseline` = a neutral edge). null when they never took a view. */
export function firstReturnOf(lean: { trustLean: number; affinityLean: number }, now: { trust: number; affinity: number }, baseline: { trust: number; affinity: number }): FirstReturn | null {
  const first = lean.trustLean + lean.affinityLean;
  if (Math.abs(first) < FIRST_RETURN.strongLean) return null;
  const took = first > 0 ? "warm" : "wary";
  const warmNow = now.trust + now.affinity >= baseline.trust + baseline.affinity;
  return { took, held: warmNow === (took === "warm") };
}

/** The small move in their own view: it settles them further into how they see the player NOW (confirmed, or admitting they were wrong). */
export function firstReturnImpact(r: FirstReturn): { trust: number; affinity: number } {
  const size = r.held ? FIRST_RETURN.held : FIRST_RETURN.overturned;
  const warmNow = (r.took === "warm") === r.held;
  return warmNow ? { trust: size.trust, affinity: size.affinity } : { trust: -size.trust, affinity: -size.affinity };
}
