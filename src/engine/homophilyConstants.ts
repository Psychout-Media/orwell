/**
 * ORW-561 / spec 0176 (Theme 3 slice 10, part 1): the tunables for homophily ("like attracts like"). One module so the feel is tuned in one place.
 * Every number here is engine-only: none ever reaches a projection, prompt, tool result or log.
 */
import { HOUSE_LEAN_TUNING } from "./houseLeans";

export const HOMOPHILY = {
  /** How strongly similarity bends bond speed: mult = 1 + (similarity - CENTER) x SPAN, then clamped to [1/F, F]. Small on purpose: a nudge, never a rule. */
  SPAN: 0.4,
  /** The similarity of an unremarkable pair (measured: the mean over 12 seeded casts, 1260 pairs, was 0.339), so the multiplier is mean-neutral over a cast: below it a pair bonds a little slower, above it a little faster. */
  CENTER: 0.34,
  /** The clamp: never more than the house-culture dials' own bound. */
  MAX_FACTOR: HOUSE_LEAN_TUNING.MAX_FACTOR,
  /** The similarity of a facet we cannot read (missing vocation / hometown / unknown label): neutral, so a thin card neither helps nor hurts. */
  NEUTRAL: 0.5,
  /** Relative weight of each component in the blend (normalised at use). */
  WEIGHTS: { age: 1, style: 1.2, archetype: 1, region: 0.8, vocation: 1 },
  /** Age: full similarity at the same age, none at this gap in years or more. */
  AGE_GAP_ZERO: 20,
  /** Style: the same family is 1; a family in the same cluster is this; anything else is 0. */
  STYLE_SAME_CLUSTER: 0.6,
  /** Region: same Census region (or both overseas) is 1, else 0; two big-city (or two non-big-city) people add this much of closeness on top of a region miss. */
  REGION_SAME_SIZE_BONUS: 0.3,
  /** Vocation: the same job sector is 1; otherwise closeness falls with the affluence gap (0..2). */
  VOCATION_SAME_SECTOR: 1,
} as const;

/** Style families grouped into loose looks (public label -> cluster). A family missing here is its own cluster. */
export const STYLE_CLUSTERS: Readonly<Record<string, string>> = {
  rocker: "edgy", punk: "edgy", goth: "edgy", skater: "edgy", y2k: "edgy", gamer: "edgy",
  preppy: "polished", southern: "polished", "country-club": "polished", "quiet-luxury": "polished", corporate: "polished", minimalist: "polished", glam: "polished", miami: "polished", academic: "polished",
  streetwear: "street", "luxury-streetwear": "street", athleisure: "sporty", "college-athlete": "sporty", healthcare: "practical", workwear: "practical",
  bohemian: "earthy", crunchy: "earthy", cottagecore: "earthy", vintage: "earthy", beachy: "earthy",
  western: "rugged", outdoorsy: "rugged", camo: "rugged", military: "rugged",
};
