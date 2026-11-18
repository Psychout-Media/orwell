import type { EntityId } from "../domain/ids";
import { clamp01 } from "../domain/num";
import type { BondReader } from "./bonds";

/**
 * Theme 3 slice 4 part 2 (ORW-568, feature 0181) - A BOND'S LIFE: JEALOUSY AND DIVIDED LOYALTY (the NEGATIVE side only; positive triads of closeness are slice 13's).
 * JEALOUSY: a holder close to X watches X spend noticeably more of the recent scenes THE HOLDER SAW (was in, or saw from the same room) on a third person than on the holder: the holder's
 * jealousy rises, and the closeness slips (a bounded damp on the holder's feeling-keep for X) unless a bonding scene with X handles it first.
 * DIVIDED LOYALTY: a holder close to two people who fall out is pulled both ways: a bounded extra keep for either, and a higher bar for breaking against either.
 * Pure, engine-only (Vault class: it reads hidden warmth, grudges and strain through the bond reader), no I/O, no rng, no text. Nothing here is shown to the player.
 */
export const BOND_JEALOUSY = {
  /** How many of the most recent recorded events the favour tally looks back over. */
  window: 60,
  /** The holder's warmth for X must reach this for X to be someone the holder can be jealous over. */
  closeBar: 0.3,
  /** The favoured third person must have shared at least this many recent scenes with X. */
  minScenes: 2,
  /** The most jealousy can ever be (strictly below 1). */
  maxJealousy: 0.6,
  /** Jealousy fades by this each night the favour does not keep it up. */
  nightlyFade: 0.1,
  /** How the favour reads: the visible scene share only (a houseguest cannot read how X feels about Y). */
  sceneWeight: 0.6,
  /** A rival the holder warms to makes them a little less jealous (0..1). */
  rivalWarmth: 0.5,
  /** At full jealousy the holder's feeling-keep for X is cut by this share (closeness slips). */
  keepDamp: 0.5,
  /** The share of the jealousy that moves the holder's mood (the existing agitation impulse, scaled). */
  moodWeight: 0.5,
  /** Culture dials are held to this band. */
  maxDial: 1.35,
  bondingShare: 0.25,
  /** DIVIDED LOYALTY: the holder's strength to each of the pair must reach this. */
  splitCloseBar: 0.25,
  /** The pair has fallen out once their grudge or strain passes this. */
  fallenBar: 0.2,
  /** The most the split can be. */
  maxSplit: 0.8,
  /** The extra keep a split holder gives either of the pair (same footing as the feeling-keep term), and the alliance-break divisor's extra. */
  splitKeepWeight: 0.3,
  splitBreakK: 1.0,
} as const;

export interface JealousyDials { loyalty?: number; bonding?: number; paranoia?: number }

const band = (x: number | undefined): number => {
  const v = x === undefined || !Number.isFinite(x) ? 1 : x;
  return Math.min(BOND_JEALOUSY.maxDial, Math.max(1 / BOND_JEALOUSY.maxDial, v));
};

/** What the holder sees of one close friend X and one third person Y. All plain numbers: the holder's own warmth, and the scene counts among scenes the holder saw. */
export interface JealousyInput {
  /** The holder's warmth for X. */
  closeWarmth: number;
  /** The holder's warmth for Y. */
  rivalWarmth: number;
  /** Recent scenes the holder saw: X-with-Y and X-with-the-holder. */
  xyScenes: number;
  xhScenes: number;
}

/**
 * The jealousy a holder feels, 0..maxJealousy: zero unless the holder is close to X and X really favours Y in the scenes the holder saw. Monotone in
 * X's scenes with Y, falls as X's scenes with the holder grow, grows with how close the holder is; the culture's paranoia and bonding lean it, loyalty damps it.
 */
export function jealousy(i: JealousyInput, dials: JealousyDials = {}): number {
  const B = BOND_JEALOUSY;
  if (!(i.closeWarmth >= B.closeBar) || i.xyScenes < B.minScenes || i.xyScenes <= i.xhScenes) return 0;
  const sceneShare = (i.xyScenes - i.xhScenes) / (i.xyScenes + i.xhScenes);
  const favour = B.sceneWeight * sceneShare;
  const raw = favour * clamp01(i.closeWarmth) * (1 - B.rivalWarmth * clamp01(i.rivalWarmth));
  const d = band(dials.paranoia) * (1 + B.bondingShare * (band(dials.bonding) - 1)) / band(dials.loyalty);
  return Math.min(B.maxJealousy, raw * d);
}

/** The overlay value after a night: it follows a higher reading up at once, and otherwise fades; never above the cap, never below zero. */
export function nextJealousy(prev: number, reading: number): number {
  return Math.min(BOND_JEALOUSY.maxJealousy, Math.max(0, reading, prev - BOND_JEALOUSY.nightlyFade));
}

/** One recorded scene as the record holds it: who was in it, and who not in it could see it from the room. */
export interface SeenScene { readonly witnessSet: readonly EntityId[]; readonly seenBy?: readonly EntityId[] }

/** A holder saw a scene when they were in it or watched it from the same room; a private scene they never saw is not theirs to be jealous over. */
export function sceneSeenBy(s: SeenScene, holder: EntityId): boolean {
  return s.witnessSet.includes(holder) || (s.seenBy ?? []).includes(holder);
}

/** How many of the given scenes (each a witness set) had both people there. */
export function sharedScenes(scenes: ReadonlyArray<readonly EntityId[]>, a: EntityId, b: EntityId): number {
  let n = 0;
  for (const w of scenes) if (w.includes(a) && w.includes(b)) n++;
  return n;
}

/** The overlay key: one holder's jealousy of one rival. */
export const jealousyKey = (holder: EntityId, rival: EntityId): string => `${holder}|${rival}`;

/** The dedupe key for one jealousy mood hit (one holder, one rival, one week): `live.jealousySeen` holds these, ordered, never pruned. */
export function jealousyMoodKey(week: number, holder: EntityId, rival: EntityId): string {
  return `jealous:${week}:${holder}:${rival}`;
}

/** The holder's keep for X once jealousy has cut it and a divided loyalty has added to it. Equal to `keep` with neither. */
export function adjustedKeep(keep: number, jealous: number, split: number): number {
  return keep * (1 - BOND_JEALOUSY.keepDamp * clamp01(jealous)) + BOND_JEALOUSY.splitKeepWeight * clamp01(split);
}

/**
 * DIVIDED LOYALTY of `h` between `a` and `b`, 0..maxSplit: zero unless `h` is close to both and the two have fallen out (the worse of their grudge or strain,
 * either way). Bigger the closer h is to the less-close of the two and the deeper the fall-out. Reads the bond reader only.
 */
export function loyaltySplit(h: EntityId, a: EntityId, b: EntityId, reader: BondReader): number {
  const B = BOND_JEALOUSY;
  if (a === b || h === a || h === b) return 0;
  const close = Math.min(reader.strength(h, a), reader.strength(h, b));
  if (!(close >= B.splitCloseBar)) return 0;
  const ab = reader.bond(a, b), ba = reader.bond(b, a);
  const fall = Math.max(ab.resentment, ba.resentment, ab.strain, ba.strain);
  if (!(fall >= B.fallenBar)) return 0;
  return Math.min(B.maxSplit, close * clamp01((fall - B.fallenBar) / (1 - B.fallenBar)));
}

/** The largest split `h` carries over `a` against any third person `h` is also close to. */
export function loyaltySplitOver(h: EntityId, a: EntityId, reader: BondReader): number {
  if (!(reader.strength(h, a) >= BOND_JEALOUSY.splitCloseBar)) return 0;
  let best = 0;
  for (const c of reader.living()) if (c !== h && c !== a) best = Math.max(best, loyaltySplit(h, a, c, reader));
  return best;
}
