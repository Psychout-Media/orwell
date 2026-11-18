import type { EntityId } from "../domain/ids";
import { clamp01Raw as clamp01 } from "../domain/num";
import type { GenderPresentation, Orientation } from "./diversityConstants";

/**
 * THEME A (ORW-657; Ryne approved all four slices 2026-11-18) - SHOWMANCES AND ATTRACTION. FOUNDATION ONLY: the core attraction model and the pure rules the slices
 * (A1-A4, ORW-658..661) build on; A and B wire them. Pure: no I/O, no rng (the caller passes keyed rolls), no Vault. Engine-only and private: an attraction is never shown
 * as a number or a label; it shows only in behaviour (who someone sits with, seeks out, protects), voiced by the narrator.
 *
 *  - A1 attraction is ONE-SIDED and private: A can be drawn to B whatever B feels. Only within A's own orientation (`canBeDrawnTo`). Most pairs have none; a few have
 *    chemistry (`chemistryOf`, a seeded per-ordered-pair draw); it grows with time spent together (`attractionNow`) and bends who A seeks out (`seekPull`).
 *  - The PLAYER as the object: an NPC can be drawn to the player only once the player has said their gender (Ryne 11-15: never assume it; ask). What the player
 *    does about it is theirs. The player's own attraction is NEVER modelled.
 *  - A2 the couple is a target: a pair the house READS as a couple (perceived, never the truth) weighs as one threat (`coupleNomPush`).
 *  - A3 heart against game: when a romance and an alliance pull opposite ways, the stronger tie wins (`heartWins`), and a breakup is the worst rupture (`BREAKUP`).
 *  - A4 the player's showmance exists only by the player's own acts (`playerShowmance`): the engine never decides the player is in one.
 */
export const ATTRACTION = {
  /** The share of eligible ordered pairs with any chemistry at all (most have none). */
  chemistryShare: 0.2,
  /** How much a full day's shared time grows an attraction (toward its chemistry ceiling), and its cap. */
  growthPerDayTogether: 0.08,
  /** How strongly an attraction pulls the drawn one toward the other when choosing whom to spend time with (added to the partner score, at full attraction). */
  seekWeight: 0.3,
  /** A2: how much more an HOH outside a perceived couple wants one of them on the block, at full perceived coupledness (signed push on the nomination read). */
  coupleNomPush: 0.25,
  /** A2: the perceived bond (0163, the reader's own view) at or above which a pair reads as a couple, with a romance seen or told. */
  coupleBondAtLeast: 0.65,
} as const;

/** A3: a breakup is the worst bond rupture - worse than a broken deal's betrayal shock (relationshipConstants BETRAYAL_SHOCK trust -0.32, affinity -0.28). */
export const BREAKUP = { trust: -0.36, affinity: -0.45, threat: 0.2 } as const;

/** One-sided: can someone of `orientation` be drawn to someone presenting as `toGender`, given their own presentation? Undefined `toGender` (the player has not said) => false. */
export function canBeDrawnTo(orientation: Orientation, ownGender: GenderPresentation, toGender: GenderPresentation | undefined): boolean {
  if (toGender === undefined) return false;
  // One side of `diversity.ts#showmancePlausible` (the same rule, read one way): open orientations are drawn to anyone; otherwise by same/different presentation.
  if (orientation === "bisexual" || orientation === "pansexual" || orientation === "queer") return true;
  return ownGender === toGender ? orientation === "gay" || orientation === "lesbian" : orientation === "straight";
}

/** The private chemistry ceiling for one ordered pair, from its own keyed roll (0..1): 0 for most pairs; a share of pairs get a ceiling in (0.4..1]. */
export function chemistryOf(roll: number, eligible: boolean): number {
  if (!eligible) return 0;
  const r = clamp01(roll);
  if (r >= ATTRACTION.chemistryShare) return 0;
  return 0.4 + 0.6 * (r / ATTRACTION.chemistryShare);
}

/** Attraction now: it grows with shared days toward the chemistry ceiling (never past it; never without chemistry). */
export const attractionNow = (chemistry: number, daysTogether: number): number => Math.min(clamp01(chemistry), Math.max(0, daysTogether) * ATTRACTION.growthPerDayTogether);

/** The pull an attraction adds to choosing that person to spend time with. */
export const seekPull = (attraction: number): number => ATTRACTION.seekWeight * clamp01(attraction);

/** A2: does `reader` read the two as a couple? Their perceived bond (own view) and whether they saw or were told of a romance. */
export const readsAsCouple = (perceivedBond: number, romanceSeenOrTold: boolean): boolean => romanceSeenOrTold && perceivedBond >= ATTRACTION.coupleBondAtLeast;

/** A2: the nomination push an HOH outside a perceived couple puts on one of them (0 when the HOH does not read them as a couple, or is in it). */
export const coupleNomPush = (hohReadsCouple: boolean, hohInIt: boolean): number => (hohReadsCouple && !hohInIt ? ATTRACTION.coupleNomPush : 0);

/** A3: when romance and alliance pull opposite ways, does the heart win? The stronger tie for THIS person wins; ties go to the heart only when the romance is mutual. */
export const heartWins = (romanceTie: number, allianceTie: number, mutual: boolean): boolean => romanceTie > allianceTie || (romanceTie === allianceTie && mutual);

/** A4: is the player in a showmance? Only by the player's OWN acts: a showmance scene the player started, answered in kind by the NPC (their attraction to the player). */
export function playerShowmance(playerStartedShowmanceScenes: number, npcDrawnToPlayer: boolean): boolean {
  return playerStartedShowmanceScenes > 0 && npcDrawnToPlayer;
}

/** The key for one ordered pair's chemistry roll (the caller seeds its own side stream from this). */
export const chemistryKey = (from: EntityId, to: EntityId): string => `chem:${from}>${to}`;
