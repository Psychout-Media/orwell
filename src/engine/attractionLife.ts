import type { EntityId } from "../domain/ids";
import { agendaRoll } from "./agenda";
import { attractionNow, canBeDrawnTo, chemistryKey, chemistryOf } from "./attraction";
import type { GenderPresentation, Orientation } from "./diversityConstants";

/**
 * 0207 Theme A, slice A1 (ORW-658): attraction in house life. The pure glue between the Auditor's foundation (`attraction.ts`: the model) and the live loop: who may be drawn to whom,
 * the keyed chemistry draw, the shared-time count, and the attraction a houseguest holds toward each person right now. Engine-only and private: nothing here is ever shown as a number or a
 * label; it moves only WHO a houseguest seeks out and flirts with (behaviour the narrator voices from third-person facts). Pure: no I/O, no shared rng (every draw is a keyed side roll).
 * No gender or orientation is assumed anywhere: eligibility is `canBeDrawnTo` over the data on the two characters, and a missing datum means no attraction.
 */
export const ATTRACTION_LIFE = {
  /** House-life stretches a pair spends in the same room that count as one shared day (growth per day is the foundation's `growthPerDayTogether`). */
  stretchesPerDay: 12,
  /** The chance, per free stretch, that someone seeks out the person they are most drawn to, at full attraction (scaled by that attraction). */
  seekChance: 0.3,
  /** The attraction at which a flirt or a cuddle can start without a seeded showmance behind it. */
  flirtAtLeast: 0.2,
  /** ORW-892: a drawn person who is in the room gets the romance chance times (attraction / flirtFullAt) for a flirt or a cuddle. Attraction is at most 1, so at 2 the chance is at most half the romance chance (a fully drawn person flirts about every other time the plain chance would). Retuned in ORW-702 slice 2: at 0.3 the house made romances in most seasons (a public couple in 3 of 4 played seasons); measured on the guard seeds, 2 keeps the mix inside its bands. */
  flirtFullAt: 2,
  /** A seeded showmance pair starts with chemistry at least this high, and with this many shared days already behind them. */
  seededChemistry: 0.7,
  seededDays: 5,
  /**
   * A2 (ORW-636 funnel): how far up an own-view read of a pair's bond a reader must be to read them as a couple, as a share of the way from the baseline to the highest an own-view read can go.
   * The foundation's `coupleBondAtLeast` (0.65) is on the whole 0..1 bond scale, but a houseguest's read of two OTHERS is the baseline plus `floaterBondSpan` times what they saw, so it tops
   * out at 0.60 and the bar was never reachable (no played season ever fired the couple term). 0.7 of the way is three net warm scenes watched: a flirtation or two is not a couple.
   */
  coupleReadShare: 0.7,
} as const;

/** A2: does this reader read the pair as a couple? Their own-view perceived bond, scaled to what that read can reach (`base` + `span`), and a romance they saw or were told of. */
export const readsAsCoupleOwnView = (perceivedBond: number, romanceSeenOrTold: boolean, base: number, span: number): boolean =>
  romanceSeenOrTold && span > 0 && (perceivedBond - base) / span >= ATTRACTION_LIFE.coupleReadShare;

/** What a character's attraction needs to be known: their own presentation and orientation. A character missing either is drawn to no one (never inferred). */
export interface AttractionIdentity { orientation: Orientation | undefined; gender: GenderPresentation | undefined }

/** One ordered pair: can `from` be drawn to `to`? Only from the two characters' own data; the player's own attraction (`from` is the player) is never modelled. */
export function drawnTo(from: AttractionIdentity | undefined, toGender: GenderPresentation | undefined): boolean {
  if (!from || from.orientation === undefined || from.gender === undefined) return false;
  return canBeDrawnTo(from.orientation, from.gender, toGender);
}

/** The keyed chemistry ceiling for one ordered pair (0 = none): the foundation's draw over this pair's own side roll. */
export function chemistryFor(seed: number, from: EntityId, to: EntityId, eligible: boolean): number {
  return chemistryOf(agendaRoll(seed, from, chemistryKey(from, to)), eligible);
}

/** Days together from the count of shared house-life stretches. */
export const daysTogether = (stretches: number): number => Math.max(0, stretches) / ATTRACTION_LIFE.stretchesPerDay;

/** The attraction `from` holds toward `to` right now, from the stored ceiling and the shared stretches (0 when none). */
export function attractionOf(chemistry: Readonly<Record<string, number>> | undefined, together: Readonly<Record<string, number>> | undefined, from: EntityId, to: EntityId): number {
  const key = chemistryKey(from, to);
  const c = chemistry?.[key];
  return c ? attractionNow(c, daysTogether(together?.[key] ?? 0)) : 0;
}

/**
 * ORW-736 (PO ruling, Ryne 2026-11-20: "showmances are a slower build over several weeks, not a switch turned on"): the PACE of a showmance. Levels are 0 spark, 1 bond, 2 sensed (close allies caught it), 3 noticed (the room has), 4 known
 * (house-wide: the public couple). Progress is chemistry-days: the days the pair spend in one room (the A1 `together` count) times their mutual chemistry. Every number has its reason; none is a per-person day count (the pair's own
 * chemistry and a keyed per-pair factor set the speed). Engine-only; nothing here is ever shown.
 */
export const SHOWMANCE_PACE = {
  /** Chemistry-days needed to reach level 1..4 (cumulative). A seeded pair holds chemistry 0.7+, measured: a pair shares about a quarter of a day per day. ORW-842 (measured over 12 played seasons, 1500 messages each): the first bars [1.5, 3, 4.5, 6.5] left every pair at level 3 or below (level 1 on days 7-12, level 2 on days 15-23, one pair at level 3 on day 20, none public); scaled to about two thirds they give level 1 on days 4-23, level 2 on days 10-17, level 3 on days 15-23 and a public couple in 2 of the pairs (days 21-27 measured with the earliest public day at 21; it stays 22, the 0207 pin), the rest fading or stalling: a strong pair goes public within about 3 to 5 weeks, most do not (the PO ruling, 2026-11-20). */
  bars: [1, 2, 3, 4.3],
  /** The least in-game days a pair must spend in level 0..3 before it can step up (time, not just a threshold crossing). */
  minDays: [2, 3, 3, 4],
  /** The earliest in-game day a public couple can form (a normal season is roughly 9-11 weeks of about five days, so this is about week 5). Derived from days, not a week number. */
  publicNotBeforeDay: 22,
  /** A level needs this share of the houseguests (the pair excluded) to have caught the romance before the room "has noticed" it, and this share before the whole house knows. Sensed needs one close ally. */
  roomShare: 0.3,
  houseShare: 0.6,
  /** Chemistry-days lost per in-game day the pair spend apart (a week apart costs about two chemistry-days: a pause at the early levels, a fade from a high one). */
  decayPerDayApart: 0.25,
  /** A day or so apart is no time at all (a night's sleep, a busy day): cooling starts after this many days with no shared time. */
  apartGraceDays: 1,
  /** A level falls back one step when progress drops below this share of its own bar. */
  fadeBelow: 0.7,
  /** A houseguest counts as a close ally of one of the pair when their own affinity for that one is at least this (or they share an alliance): the sensed step needs one such person to have caught it. */
  closeAffinity: 0.6,
  /** The per-pair speed spread (the keyed factor is 1 +/- this), so no two pairs keep the same calendar. */
  jitter: 0.25,
} as const;
