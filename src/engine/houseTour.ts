/**
 * ORW-654 / feature 0206 - THE SELF-GUIDED TOUR (`ORWELL_HOUSE_TOUR`). Pure (no I/O, no shared rng).
 *
 * After the player walks in they are free to explore until production calls the champagne circle. The houseguests who are inside mostly stand about in the
 * open common area (the living room, the kitchen and the dining room) with a few wandering elsewhere. Where one person stands is a keyed side stream of
 * (season seed, houseguest, step), so it is reproducible, never touches the season rng, and never moves the calibration base. Ids only, Vault-free.
 */
import type { Room } from "../domain/house";
import { HOUSE_ROOMS, WALKABLE_ROOMS } from "../domain/house";
import { SeededRandom } from "../adapters/random/SeededRandom";
import { hashSeed } from "./characterFactory";

/** The tour's tuning. `wanderShare` is the chance, per houseguest per step, that they are somewhere other than their spot in the common area. */
export const HOUSE_TOUR = { wanderShare: 0.2 } as const;

/** The persisted tour record: the rooms the player has stepped into (append-only; the first entry into each is the one-time card). */
export interface HouseTourState { seen: string[] }

/** The slice of the live season the tour reads (structural, so this module never imports `liveSeason`, which carries `HouseTourState`: no import cycle). */
export interface TourSeasonView { houseTour?: HouseTourState; premiereEntrance?: { stage: string; arrived: number; playerPos: number; order: readonly unknown[] } }

/** The open common area: the open-plan rooms a houseguest settles in before anything is called. */
export function isCommonArea(room: Room): boolean {
  return room === "living-room" || room === "kitchen" || room === "dining-room";
}

const COMMON_ROOMS: readonly Room[] = HOUSE_ROOMS.filter(isCommonArea);
/** Where a wanderer can be: any room a houseguest may stand in now (nobody holds the crown yet, so not the HOH room). */
const WANDER_ROOMS: readonly Room[] = WALKABLE_ROOMS.filter((r) => r !== "hoh-room");

const unit = (key: string): number => new SeededRandom(hashSeed(key)).next();

/** The room one arrived houseguest stands in at this step of the tour. */
export function tourRoomFor(seed: number | string, id: string, step: number | string): Room {
  if (unit(`${seed}:tour:wander:${id}:${step}`) < HOUSE_TOUR.wanderShare) {
    return WANDER_ROOMS[Math.floor(unit(`${seed}:tour:where:${id}:${step}`) * WANDER_ROOMS.length)]!;
  }
  return COMMON_ROOMS[Math.floor(unit(`${seed}:tour:home:${id}`) * COMMON_ROOMS.length)]!;
}

/**
 * Is the player free to walk the house right now? True only for an armed tour (a played game with the flag on) from the moment the player has walked in
 * until the circle is called (the premiere stays in its `entrances` stage through the tour, so the toast and the bed rush keep their places).
 */
export function tourFree(s: TourSeasonView | null | undefined): boolean {
  const pe = s?.premiereEntrance;
  return !!s?.houseTour && !!pe && pe.stage === "entrances" && pe.arrived > pe.playerPos;
}

/** Has every houseguest walked in (the tour's second half: the house is full and production has not yet called the circle)? */
export function everyoneIn(s: TourSeasonView | null | undefined): boolean {
  const pe = s?.premiereEntrance;
  return !!pe && pe.arrived >= pe.order.length;
}

/** The save check's rule for the record: a room once entered is never forgotten. */
export function houseTourSuperset(later: HouseTourState | undefined, earlier: HouseTourState | undefined): boolean {
  if (!earlier || earlier.seen.length === 0) return true;
  const have = new Set(later?.seen ?? []);
  return earlier.seen.every((r) => have.has(r));
}
