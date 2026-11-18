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
  /** A seeded showmance pair starts with chemistry at least this high, and with this many shared days already behind them. */
  seededChemistry: 0.7,
  seededDays: 5,
} as const;

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
