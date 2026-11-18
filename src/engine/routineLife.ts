import type { EntityId } from "../domain/ids";
import type { TimeOfDay } from "./timeOfDay";
import { followsRoutine, ROUTINES, type Routine } from "./routines";

/**
 * ORW-651 / spec 0209 (the build): the pure helpers that turn the foundation's routines into live house-life behaviour. No I/O, no rng (callers pass keyed rolls), no Vault
 * (a routine is engine-held; the player learns one only by seeing it). The composition of a routine from the character lives in `houseLife.ts` beside the action library.
 */
export const ROUTINE_LIFE = {
  /** Below this mood a houseguest is "low": their routines slip like they do on the block (the foundation's `stressedShare`). */
  stressedMood: 0.35,
} as const;

/** Routines slip when the game bites: on the block, or low. */
export const isStressed = (emotional: number, onTheBlock: boolean): boolean => onTheBlock || emotional < ROUTINE_LIFE.stressedMood;

/** A routine's stable key (its time, place and act): what a sighting is counted against. */
export const routineKey = (r: Pick<Routine, "slot" | "place" | "action">): string => `${r.slot}:${r.place}:${r.action}`;

/** The one routine that pulls now: of those at this time of day, the strongest first, the first whose own keyed roll lands (`roll` is keyed per routine; never a shared draw). */
export function routineNow(rs: readonly Routine[], now: TimeOfDay, stressed: boolean, roll: (key: string) => number): Routine | undefined {
  return rs.filter((r) => r.slot === now).sort((a, b) => b.strength - a.strength || routineKey(a).localeCompare(routineKey(b))).find((r) => followsRoutine(r, now, stressed, roll(routineKey(r))));
}

/** Days the PLAYER has seen each houseguest keep each routine (hidden, engine-only). Monotonic: days are only ever added. */
export type RoutineSightings = Record<EntityId, Record<string, number[]>>;

/** Count a sighting on `day`; `learned` is true exactly when this sighting brings the distinct days to the learning threshold. */
export function noteSighting(store: RoutineSightings, holder: EntityId, key: string, day: number): { days: number; learned: boolean } {
  const byKey = (store[holder] ??= {});
  const days = (byKey[key] ??= []);
  if (days.includes(day)) return { days: days.length, learned: false };
  days.push(day);
  return { days: days.length, learned: days.length === ROUTINES.learnAfterDays };
}

/** Add routines for houseguests that have none yet; an existing houseguest's routines are never replaced or thinned (non-degradation). */
export function addRoutines(store: Record<EntityId, Routine[]>, id: EntityId, rs: readonly Routine[]): Routine[] {
  return (store[id] ??= [...rs]);
}
