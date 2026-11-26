import type { EntityId } from "../domain/ids";
import type { TimeOfDay } from "./timeOfDay";
import { followsRoutine, knowsRoutine, type Routine } from "./routines";

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

/**
 * The one routine that pulls now: of those at this time of day, the strongest first, the first whose own keyed roll lands (`roll` is keyed per routine; never a shared draw).
 * ORW-960 (B2-8): an authored routine (from the backstory) leads a floor one at the same time; a list of one source only (every list before authored habits could land late) sorts as before.
 */
export function routineNow(rs: readonly Routine[], now: TimeOfDay, stressed: boolean, roll: (key: string) => number): Routine | undefined {
  const authored = (r: Routine): number => (r.source === "authored" ? 1 : 0);
  return rs.filter((r) => r.slot === now && r.retiredWeek === undefined).sort((a, b) => authored(b) - authored(a) || b.strength - a.strength || routineKey(a).localeCompare(routineKey(b))).find((r) => followsRoutine(r, now, stressed, roll(routineKey(r))));
}

/** Days an onlooker has seen each houseguest keep each routine (hidden, engine-only): the PLAYER's in `live.routineSightings`, each NPC's in `live.npcRoutineSightings[onlooker]`. Monotonic: days are only ever added. */
export type RoutineSightings = Record<EntityId, Record<string, number[]>>;

/** Count a sighting on `day`; `learned` is true exactly when this sighting brings the distinct days to the learning threshold. */
export function noteSighting(store: RoutineSightings, holder: EntityId, key: string, day: number): { days: number; learned: boolean } {
  const byKey = (store[holder] ??= {});
  const days = (byKey[key] ??= []);
  if (days.includes(day)) return { days: days.length, learned: false };
  days.push(day);
  return { days: days.length, learned: knowsRoutine(days.length) && !knowsRoutine(days.length - 1) };
}

/** Add routines for houseguests that have none yet; an existing houseguest's routines are never replaced or thinned (non-degradation). */
export function addRoutines(store: Record<EntityId, Routine[]>, id: EntityId, rs: readonly Routine[]): Routine[] {
  return (store[id] ??= [...rs]);
}

/**
 * ORW-960 (B2-8): routines were written once, at a houseguest's first house-life hour, so habits the cast-authoring pass wrote LATER never became routines. When authored
 * routines arrive for a houseguest who has only floor ones, they are added (each new time-place-act once); the floor ones stay (non-degradation: never replaced or thinned,
 * and what onlookers already learned of them stays true), and the authored ones lead at their time (`routineNow`). Once a houseguest has authored routines this is a no-op.
 */
export function mergeAuthoredRoutines(store: Record<EntityId, Routine[]>, id: EntityId, authored: readonly Routine[]): Routine[] {
  const have = store[id];
  if (!have) return addRoutines(store, id, authored);
  if (have.some((r) => r.source === "authored")) return have;
  for (const r of authored) if (r.source === "authored" && !have.some((x) => routineKey(x) === routineKey(r))) have.push(r);
  return have;
}

/** ORW-980: routines change as the houseguest changes. The smallest engine fact: a houseguest put on the block sets one routine aside and takes up another (additive: the old row stays, flagged). */
export const ROUTINE_CHANGE = {
  /** A houseguest changes at most this many times in a season (a stable person, not a weathervane). */
  perSeason: 2,
  /** They keep at least this many routines going after a change. */
  keepActive: 2,
} as const;

/** The routines that still pull. */
export const activeRoutines = (rs: readonly Routine[]): Routine[] => rs.filter((r) => r.retiredWeek === undefined);

/**
 * Apply one change for a houseguest who is on the block in `week`: set one active routine aside (the keyed roll `roll(key)` ranks them; the highest goes) and add one composed by
 * `compose(takenActs)` (a new act, never one they already have or had). Returns true when a change was made. No-op if they already changed this week, have used the season's
 * changes, have too few routines to spare, or `compose` has nothing new. Never removes a row, never rewrites one beyond the retired flag.
 */
export function changeRoutines(rs: Routine[], week: number, roll: (key: string) => number, compose: (taken: ReadonlySet<string>) => Routine | undefined): boolean {
  const changed = new Set(rs.filter((r) => r.retiredWeek !== undefined).map((r) => r.retiredWeek));
  if (changed.has(week) || changed.size >= ROUTINE_CHANGE.perSeason) return false;
  const live = activeRoutines(rs);
  if (live.length < ROUTINE_CHANGE.keepActive) return false;
  const fresh = compose(new Set(rs.map((r) => r.action)));
  if (!fresh) return false;
  const gone = [...live].sort((a, b) => roll(`routine-retire:w${week}:${routineKey(b)}`) - roll(`routine-retire:w${week}:${routineKey(a)}`) || routineKey(a).localeCompare(routineKey(b)))[0]!;
  gone.retiredWeek = week;
  rs.push({ ...fresh, sinceWeek: week });
  return true;
}
