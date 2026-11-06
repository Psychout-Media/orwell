import type { EdgeSignals } from "./relationships";
import type { TieNature } from "./seededRelationships";

/**
 * B50 (Ryne's accuseTie ruling 2026-11-05; flag ORWELL_ACCUSE_COST, off by default) - ACCUSING a pre-show tie has consequences. "Falsely accusing someone should definitely ding. But honestly accusing
 * someone should always have the chance of negatively affecting someone. Or maybe they respect it?" A MISS dings the accuser with the accused pair (and a tiny ripple with the room); a HIT carries a chance
 * of resentment OR respect from each member of the exposed pair, decided by the ENGINE from their relationship with the accuser, their own temperament and what the tie is - never from the accuser's wording
 * (accuseTie takes no wording). Bounded, seeded, recorded, no number shown. Every magnitude lives here (ASSUMED, pending Ryne).
 */
export const ACCUSE = {
  /** What a MISS costs the accuser with EACH accused houseguest (a wrong, public guess about their private history). Smaller than a betrayal. */
  missImpact: { trust: -0.1, affinity: -0.08, threat: +0.06 } as Partial<EdgeSignals>,
  /** The tiny ripple on each witness's read of the accuser after a miss. */
  missRipple: { trust: -0.02 } as Partial<EdgeSignals>,
  /** A HIT that sours: the exposed member resents being outed. */
  hitSourImpact: { trust: -0.12, affinity: -0.1, threat: +0.08 } as Partial<EdgeSignals>,
  /** A HIT that earns respect: they admire the read. */
  hitRespectImpact: { affinity: +0.08, trust: +0.05 } as Partial<EdgeSignals>,
  /** Base chance a hit sours; raised when they trust the accuser little, when the exposed tie is one that hurts to have outed, and when they are prickly. */
  baseSour: 0.4,
  trustWeight: 0.3,
  pricklyWeight: 0.2,
  /** Extra chance to sour by what the tie was (a hidden family / ex / romance blowing up hurts more than a shared hometown). */
  natureHurt: {
    family: 0.2, ex: 0.2, "prior-romance": 0.2, "old-friend": 0.1, rival: 0.05,
    "casting-callback": 0, "mutual-friend": 0, "shared-hometown": 0, "old-acquaintance": 0, "former-teammate": 0, "online-acquaintance": 0,
  } as Readonly<Record<TieNature, number>>,
  maxSour: 0.85,
  minSour: 0.1,
} as const;

/** P(a HIT sours this member): monotone in distrust of the accuser, in prickliness (0..1) and in how much the tie hurts. Pure. */
export function sourChance(trustOfAccuser: number, prickly: number, nature: TieNature): number {
  const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
  const p = ACCUSE.baseSour + ACCUSE.trustWeight * (1 - clamp01(trustOfAccuser)) + ACCUSE.pricklyWeight * clamp01(prickly) + ACCUSE.natureHurt[nature] - 0.5 * ACCUSE.trustWeight;
  return Math.max(ACCUSE.minSour, Math.min(ACCUSE.maxSour, p));
}

/** The engine's reaction to an honest accusation from a draw in [0,1): resentment or respect. Deterministic in the roll. */
export function hitReaction(roll: number, pSour: number): "sour" | "respect" {
  return roll < pSour ? "sour" : "respect";
}
