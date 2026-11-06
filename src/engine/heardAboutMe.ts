/**
 * B24 / #2017 section 14.5(5) (M2c) - HEARD-ABOUT-ME. What a houseguest is TOLD about the player in a recorded chat scene becomes a belief claim they hold (engine-only), at the TELLER's reliability.
 * Pure rules only (no I/O, no rng of its own, no Vault): the caller supplies the dedicated seeded roll. A tell is sometimes wrong BY CONSTRUCTION - the listener mishears it and attaches it to a
 * different houseguest - with a bounded chance that shrinks as the teller's reliability grows, so a trusted teller is believed and almost never garbled, a distrusted one lands weakly and is the
 * likeliest to be misheard. The claim moves no relationship edge and folds no memory: it is a belief, and only the later nominations / deal consent that already READ beliefs ever show it.
 */
import { clamp01 } from "../domain/num";
export type HeardNature = "targeting" | "betrayal";

export const HEARD = {
  /** The confidence of a tell from a teller the listener does not trust at all. */
  floorConfidence: 0.2,
  /** The confidence of a tell from a fully reliable teller (never certainty: it is hearsay). */
  ceilConfidence: 0.8,
  /** The most a tell can be misheard: the chance at zero reliability (it falls linearly to 0 at full reliability). */
  misheardP: 0.2,
  /** Added to the listener's trust in the teller when the listener credits them as a word-keeper (the 0121 reliability reputation). */
  creditedBonus: 0.1,
} as const;

export function isHeardNature(x: unknown): x is HeardNature {
  return x === "targeting" || x === "betrayal";
}

/** How far the listener credits the teller, 0..1: their trust in them, plus a bonus when they credit them as a word-keeper. */
export function tellerReliability(trustInTeller: number, creditedAsKeepingWord: boolean): number {
  return clamp01(clamp01(trustInTeller) + (creditedAsKeepingWord ? HEARD.creditedBonus : 0));
}

/** The confidence the listener holds a tell at: monotone in the teller's reliability, bounded to [floor, ceiling]. */
export function heardConfidence(reliability: number): number {
  return HEARD.floorConfidence + (HEARD.ceilConfidence - HEARD.floorConfidence) * clamp01(reliability);
}

/** Is this tell misheard? `roll` is a draw in [0,1) from a dedicated seeded stream (never the shared one). Chance = misheardP x (1 - reliability): bounded by misheardP, 0 for a fully reliable teller. */
export function isMisheard(roll: number, reliability: number): boolean {
  return clamp01(roll) < HEARD.misheardP * (1 - clamp01(reliability));
}
