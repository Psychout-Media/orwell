import { clamp01Raw as clamp01 } from "../domain/num";

/**
 * Feature 0184 (Theme 3 slice 8, part 1, ORW-564) - A HOUSEGUEST'S REPUTATION AS ONE OBSERVER HOLDS IT. Pure: no I/O, no rng, no Vault, no clock. ENGINE-ONLY: never projected, never a number or a label to the player.
 * What the observer has HEARD or SEEN about the target lying to, or turning on, other people (their own belief claims about the target), softened by promises the target KEPT to the observer. An observer who heard
 * and saw nothing holds the target at 1 (no standing at all). The observer's own caught lies stay with `credibility` (B48 / ORW-587); this module reads only the rest, so a lie is never counted twice.
 * Bounded to [REPUTATION.floor, 1]: a bad name is never believed at exactly zero, and nothing here can RAISE a standing above 1.
 */
export const REPUTATION = {
  /** Each wrong the observer heard of multiplies the standing by (1 - perHeardWrong x confidence x recency). */
  perHeardWrong: 0.2,
  /** A heard wrong's weight halves every this many weeks (never fully forgotten). */
  halfLifeWeeks: 6,
  /** Each promise the target kept to the observer closes this share of the gap back to 1, up to `softenCap` of it. */
  perKeptSoftens: 0.15,
  softenCap: 0.5,
  floor: 0.35,
  /** An observer willing to deal with a target they hold at standing s loses this x (1 - s) of their willingness (the existing signed mood term). */
  dealDrag: 0.12,
  /** Technical bound on the evidence read per pair (not a gameplay cap). */
  evidenceSafetyValve: 500,
} as const;

export interface HeardWrong {
  /** The week the observer heard or saw it. */
  week: number;
  /** 0..1 how sure the observer is of it. */
  confidence: number;
}

/** The observer's standing of the target, [REPUTATION.floor, 1]. */
export function standing(heard: readonly HeardWrong[], keptToObserver: number, nowWeek: number): number {
  let s = 1;
  const n = Math.min(heard.length, REPUTATION.evidenceSafetyValve);
  for (let i = 0; i < n; i++) {
    const h = heard[i]!;
    const recency = Math.pow(0.5, Math.max(0, nowWeek - h.week) / REPUTATION.halfLifeWeeks);
    s *= 1 - clamp01(REPUTATION.perHeardWrong * clamp01(h.confidence) * recency);
  }
  const softened = s + (1 - s) * Math.min(REPUTATION.softenCap, Math.max(0, Math.floor(keptToObserver)) * REPUTATION.perKeptSoftens);
  return Math.max(REPUTATION.floor, Math.min(1, softened));
}

/** How far the observer's word-credit for a speaker is scaled by the speaker's standing, bounded below by `floor` (the credibility floor), so the product with `credibility` never reaches zero. */
export function composeWithCredibility(credibility: number, standingValue: number, floor: number): number {
  return Math.max(floor, Math.min(1, credibility * standingValue));
}

/** The signed shift (<= 0) a poor standing puts on the observer's willingness to deal. 0 at standing 1. */
export function dealWillingnessShift(standingValue: number): number {
  return -REPUTATION.dealDrag * (1 - Math.max(REPUTATION.floor, Math.min(1, standingValue)));
}
