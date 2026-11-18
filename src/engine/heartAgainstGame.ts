import type { EntityId } from "../domain/ids";
import { clamp01Raw as clamp01 } from "../domain/num";
import { heartWins } from "./attraction";

/**
 * THEME A, slice A3 (ORW-660, feature 0207) - HEART AGAINST GAME, AND THE WORST RUPTURE. Two pure rules over reads the engine already holds; no rng, no I/O, no Vault.
 *
 *  1. HEART AGAINST GAME. A houseguest whose showmance partner and whose alliance pull opposite ways at a decision (a nomination, a replacement, an eviction vote) does not
 *     choose like everyone else: the stronger tie FOR THEM wins (`heartWins`, the foundation's rule), and how strong each tie is for them depends on who they are (`sentimentOf`:
 *     style, volatility, whether they keep grudges, and the house culture's bonding and loyalty dials). The result is one bounded, continuous nudge to the existing
 *     feeling-keep term (`keepAfterHeart`), never a new term name, never a menu, never a hard block.
 *  2. A BREAKUP IS THE WORST RUPTURE. A showmance that ends in the house writes a grudge heavier than a broken deal's (`GRUDGES.HEARTBREAK_SEVERITY` over `DEAL_BREAK_SEVERITY`) and
 *     the deepest strain in the bond record (`BOND.breakup*`); the jury, revenge and bitter-juror readers pick it up through the one grudge weight.
 *
 * ENGINE-ONLY (Vault class): it reads hidden ties and sentiment. Nothing from here is ever shown as a number or a label; the narrator voices only the later behaviour.
 */
export const HEART = {
  /** A romance strand (0..1) at or above this makes the partner a tie that can pull at all. */
  romanceBar: 0.3,
  /** An alliance pull (0..1) at or above this is a real pull the other way. */
  allianceBar: 0.2,
  /** The most a winning heart adds to the feeling-keep term (the term's own ceiling is 0.18), at a full margin. */
  boost: 0.3,
  /** The share of the feeling-keep term a winning game strips, at a full margin (strictly below 1: it never turns the hold into a push). */
  cut: 0.8,
  /** How much each tie is weighted by sentiment: the heart by (floor + sentiment), the game by (ceiling - sentiment). 0..1 sentiment spans the weights 0.5..1.5. */
  weightFloor: 0.5,
  weightCeiling: 1.5,
  /** How strongly an alliance pulls when the alliance's own HOH put the partner on the block (against reading the members' private threat). */
  hohPull: 1,
  /** The strain a decision leaves on the tie that lost it (shaken either way), in the bond record's own strain units (a clash is 0.12). */
  shaken: 0.12,
  /** Sentiment (0..1, how far feeling outweighs the game) by the houseguest's own strategy style: a closed engine table over the closed style enum, never shown. */
  styleSentiment: { emotional: 0.85, loyal: 0.6, social: 0.55, "under-the-radar": 0.4, strategic: 0.25, aggressive: 0.2 } as Readonly<Record<string, number>>,
  styleDefault: 0.5,
  /** The share of sentiment that comes from the soul's volatility (a volatile houseguest is ruled by what they feel). */
  volatilityShare: 0.3,
  /** A grudge-keeper is a harder houseguest: this much less sentiment. */
  keeperShift: -0.1,
  /** How much one unit of a culture dial above 1 moves sentiment (bonding raises it) or the alliance tie (loyalty raises it). Dials are held to the culture band by the caller. */
  dialShare: 0.5,
} as const;

/** One houseguest's own lean, 0..1: how far feeling outweighs the game for THEM. Pure; every input is a read the engine already has. */
export function sentimentOf(who: { style?: string; volatility: number; keeper: boolean; bonding?: number }): number {
  const base = HEART.styleSentiment[who.style ?? ""] ?? HEART.styleDefault;
  const vol = clamp01(Number.isFinite(who.volatility) ? who.volatility : 0.5);
  const mixed = (1 - HEART.volatilityShare) * base + HEART.volatilityShare * vol;
  const bonding = who.bonding !== undefined && Number.isFinite(who.bonding) ? who.bonding - 1 : 0;
  return clamp01(mixed + (who.keeper ? HEART.keeperShift : 0) + HEART.dialShare * bonding);
}

export interface HeartCase {
  /** The holder's romance strand toward the partner (0..1). */
  romanceTie: number;
  /** The strongest pull of an alliance the holder is in, against the partner (0..1). */
  allianceTie: number;
  /** The holder's own sentiment (`sentimentOf`). */
  sentiment: number;
  /** Whether the partner feels it too (their own romance strand toward the holder clears the bar). */
  mutual: boolean;
  /** The house culture's loyalty dial (1 = none): a loyal house weighs the alliance more. */
  loyalty?: number;
}

export interface HeartOutcome {
  /** Both ties are real and pull opposite ways. False means this rule changes nothing. */
  conflict: boolean;
  heartWon: boolean;
  /** 0..1: how decisively the winner won. */
  margin: number;
}

const NO_CONFLICT: HeartOutcome = { conflict: false, heartWon: false, margin: 0 };

/** Does the heart win, and by how much, for THIS houseguest. The foundation's `heartWins` decides; the weights are the houseguest's own. */
export function heartAgainstGame(c: HeartCase): HeartOutcome {
  const romance = clamp01(c.romanceTie), alliance = clamp01(c.allianceTie);
  if (!(romance >= HEART.romanceBar) || !(alliance >= HEART.allianceBar)) return NO_CONFLICT;
  const s = clamp01(c.sentiment);
  const loyal = c.loyalty !== undefined && Number.isFinite(c.loyalty) ? c.loyalty - 1 : 0;
  const heart = romance * (HEART.weightFloor + s);
  const game = alliance * (HEART.weightCeiling - s) * (1 + HEART.dialShare * loyal);
  return { conflict: true, heartWon: heartWins(heart, game, c.mutual), margin: clamp01(Math.abs(heart - game)) };
}

/** The feeling-keep value after the heart-against-game weighing: a winning heart adds to it, a winning game strips part of it. Equal to `keep` with no conflict. */
export function keepAfterHeart(keep: number, o: HeartOutcome): number {
  if (!o.conflict) return keep;
  return o.heartWon ? keep + HEART.boost * o.margin : keep * (1 - HEART.cut * o.margin);
}

/** The unordered key of a pair, sorted so both directions read the same romance. */
export const romancePairKey = (a: EntityId, b: EntityId): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** The dedupe key for one decision that shook one holder (one holder, one partner, one week): `live.feelingsSeen` holds these, ordered, never pruned. */
export const shakenKey = (week: number, holder: EntityId, partner: EntityId): string => `heart:${week}:${holder}:${partner}`;
