import type { EntityId } from "../domain/ids";
import { clamp01 } from "../domain/num";
import type { BondReader, BondView } from "./bonds";

/**
 * Theme 3 slice 4 part 1 (ORW-568, feature 0181) - A BOND'S LIFE: FEELINGS VS STRATEGY, AND GUILT AFTER A BETRAYAL. A houseguest's plan can say "cut them" while
 * the real feeling for that person says no. This module only works out HOW MUCH the feeling holds a holder back (a bounded `hesitation`, never a hard block) and
 * how hard a betrayal lands on the betrayer afterwards (a 0..1 `guiltScale` for the existing 'betrayed' mood impulse). It reads a `BondView` (the Auditor's bond
 * record, through the bond reader) and writes nothing, rolls nothing, shows nothing.
 *
 * ENGINE-ONLY (Vault class: it reads hidden warmth and resentment). Pure: no I/O, no rng, deterministic. No number from here crosses to the player: the only
 * thing that ever surfaces is the existing mood word, through the channels that already read the soul.
 */
export const BOND_FEELINGS = {
  /** The most a feeling can hold a holder back: strictly below 1, so a plan is made less likely, never impossible. */
  maxHesitation: 0.6,
  /** How much a frayed bond damps the hesitation (a strained friendship holds back a little less). 0..1. */
  strainDamp: 0.3,
  /** The alliance-break threshold is divided by (1 + k x hesitation). */
  allianceBreakK: 1.0,
  /** The most a guilt impulse can be, against a full 'betrayed' impulse of 1. */
  guiltWeight: 0.7,
  /** A betrayer feels guilt only when their real feeling (warmth x (1 - resentment)) for the wronged passes this bar. */
  guiltBar: 0.25,
  /** The weight of the signed vote term that keeps a nominee the voter truly likes (same footing as the other vote terms). */
  voteTermWeight: 0.3,
  /** Culture dials are held to this band even if a caller hands in more (mirrors the culture bound). */
  maxDial: 1.35,
  /** How much of the bonding dial reaches guilt (a small share: loyalty and paranoia carry it). 0..1. */
  bondingShare: 0.25,
} as const;

/** The culture dials guilt reads; each is exactly 1 with no culture. */
export interface FeelingDials { loyalty?: number; bonding?: number; paranoia?: number }

const band = (x: number | undefined): number => {
  const v = x === undefined || !Number.isFinite(x) ? 1 : x;
  return Math.min(BOND_FEELINGS.maxDial, Math.max(1 / BOND_FEELINGS.maxDial, v));
};

/** The real feeling a holder has for another, apart from strategy: warmth, cut by a grudge. 0..1 (0 for a stranger or a grudge-holder). */
export function feeling(view: Pick<BondView, "warmth" | "resentment">): number {
  return clamp01(view.warmth) * (1 - clamp01(view.resentment));
}

/** How much the feeling holds the holder back from moving against `view.other`: monotone in warmth, falls with resentment, damped a little by strain, strictly < 1. */
export function hesitation(view: Pick<BondView, "warmth" | "resentment" | "strain">): number {
  const damp = 1 - BOND_FEELINGS.strainDamp * clamp01(view.strain);
  return BOND_FEELINGS.maxHesitation * feeling(view) * damp;
}

/** THE single hook (the Auditor's slice 1 plan roll reads this): how much `holder`'s feeling for `other` holds them back from cutting them. */
export function hesitationFor(holder: EntityId, other: EntityId, reader: BondReader): number {
  return hesitation(reader.bond(holder, other));
}

/** The eviction-vote provider's value: positive = keeps the nominee the voter truly likes (voteChoice subtracts it). */
export function feelingKeep(view: Pick<BondView, "warmth" | "resentment" | "strain">): number {
  return BOND_FEELINGS.voteTermWeight * hesitation(view);
}

/** The divisor an alliance-break threshold takes: 1 with no feeling. */
export function breakDivisor(view: Pick<BondView, "warmth" | "resentment" | "strain">): number {
  return 1 + BOND_FEELINGS.allianceBreakK * hesitation(view);
}

/** The scale of the existing 'betrayed' impulse a betrayer catches after hurting `view.other`: 0 for a stranger or a grudge-holder, larger with warmth, bounded below 1. */
export function guiltScale(view: Pick<BondView, "warmth" | "resentment">, dials: FeelingDials = {}): number {
  const base = feeling(view) * BOND_FEELINGS.guiltWeight;
  if (!(base > 0)) return 0;
  const d = band(dials.loyalty) * (1 + BOND_FEELINGS.bondingShare * (band(dials.bonding) - 1)) * band(dials.paranoia);
  return Math.min(0.95, base * d);
}

/** Does this betrayer feel it at all: their real feeling for the wronged passes the bar. */
export function feelsGuilt(view: Pick<BondView, "warmth" | "resentment">): boolean {
  return feeling(view) >= BOND_FEELINGS.guiltBar;
}

/** The dedupe key for one guilt event (one betrayer, one wronged, one week): `live.feelingsSeen` holds these, ordered, never pruned. */
export function guiltKey(week: number, betrayer: EntityId, wronged: EntityId): string {
  return `guilt:${week}:${betrayer}:${wronged}`;
}

/** Record a key in the ordered seen-list; false (and no change) when it was already there. */
export function markFeeling(seen: string[], key: string): boolean {
  if (seen.includes(key)) return false;
  seen.push(key);
  return true;
}
