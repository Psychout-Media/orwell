/**
 * ORW-466 - assigned beds (Ryne 2026-11-15). Pure, no I/O, no shared randomness (the caller hands a side stream).
 *
 * Every houseguest owns one bed in one of the three bedrooms. A bed is TAKEN while its owner is still in the house; an evicted owner's bed is free again, and nothing is
 * deleted: the claim history is kept for the season (non-degradation). The HOH sleeps in the HOH room for their week; their own bed waits (`sleepRoomOf`).
 * "Roommates" is a fact (same room), never a stored label (ADR 0002).
 */
import type { EntityId } from "../domain/ids";
import type { Room } from "../domain/house";
import { BEDROOM_LAYOUT, type BedroomSpec } from "./data/bedrooms";

/** `${room}#${n}`, n from 1. */
export type BedId = string;

export interface BedClaim {
  readonly who: EntityId;
  readonly bed: BedId;
  readonly day: number;
  /** move-in: claimed on move-in day in entrance order; leftover: the bed left over at the player's first bedtime (they never picked one). */
  readonly why: "move-in" | "leftover";
}

export interface BedsState {
  /** Each houseguest's bed now. An evicted houseguest keeps the entry (history); their bed reads free through `takenBeds`. */
  owner: Record<EntityId, BedId>;
  /** Every claim, in order. Append-only. */
  claims: BedClaim[];
}

export const bedId = (room: Room, n: number): BedId => `${room}#${n}`;
export const roomOfBed = (bed: BedId): Room => bed.slice(0, bed.lastIndexOf("#")) as Room;

export function allBeds(layout: readonly BedroomSpec[] = BEDROOM_LAYOUT): BedId[] {
  return layout.flatMap((r) => Array.from({ length: r.beds }, (_, i) => bedId(r.room, i + 1)));
}

/** Beds whose owner is still in the house. */
export function takenBeds(state: BedsState, inHouse: ReadonlySet<EntityId>): Set<BedId> {
  return new Set(Object.entries(state.owner).filter(([who]) => inHouse.has(who)).map(([, bed]) => bed));
}

export function freeBeds(state: BedsState, inHouse: ReadonlySet<EntityId>, layout: readonly BedroomSpec[] = BEDROOM_LAYOUT): BedId[] {
  const taken = takenBeds(state, inHouse);
  return allBeds(layout).filter((b) => !taken.has(b));
}

/** Who sleeps in `room` now (owners still in the house). */
export function roommatesIn(state: BedsState, room: Room, inHouse: ReadonlySet<EntityId>): EntityId[] {
  return Object.entries(state.owner).filter(([who, bed]) => inHouse.has(who) && roomOfBed(bed) === room).map(([who]) => who);
}

/** Claim a free bed. Returns false (and changes nothing) when the bed is not free or does not exist. */
export function claimBed(state: BedsState, who: EntityId, bed: BedId, day: number, why: BedClaim["why"], inHouse: ReadonlySet<EntityId>, layout: readonly BedroomSpec[] = BEDROOM_LAYOUT): boolean {
  if (!freeBeds(state, inHouse, layout).includes(bed)) return false;
  state.owner[who] = bed;
  state.claims.push({ who, bed, day, why });
  return true;
}

/**
 * Move-in day: the houseguests in `order` (entrance order, early arrivals first - as on the show) each claim a bed. `score(who, room, roommatesSoFar)` is the engine's read of how much
 * `who` wants that room (who is already in it, their personality); `noise` is a side-stream draw in [0,1) per (who, room) that breaks ties and adds a little luck.
 * Rooms that are full are skipped. Anyone in `skip` (the player, who picks for themselves) claims nothing here.
 */
export function moveInBeds(
  order: readonly EntityId[],
  score: (who: EntityId, room: Room, roommatesSoFar: readonly EntityId[]) => number,
  noise: (who: EntityId, room: Room) => number,
  opts: { skip?: ReadonlySet<EntityId>; day?: number; layout?: readonly BedroomSpec[] } = {},
): BedsState {
  const layout = opts.layout ?? BEDROOM_LAYOUT;
  const state: BedsState = { owner: {}, claims: [] };
  const everyone = new Set(order);
  for (const who of order) {
    if (opts.skip?.has(who)) continue;
    const free = freeBeds(state, everyone, layout);
    let best: { room: Room; v: number } | undefined;
    for (const r of layout) {
      if (!free.some((b) => roomOfBed(b) === r.room)) continue;
      const v = score(who, r.room, roommatesIn(state, r.room, everyone)) + NOISE_WEIGHT * noise(who, r.room);
      if (!best || v > best.v) best = { room: r.room, v };
    }
    if (!best) break; // every bed is taken
    claimBed(state, who, free.find((b) => roomOfBed(b) === best!.room)!, opts.day ?? 1, "move-in", everyone, layout);
  }
  return state;
}

/** How much a social (or private) nature pulls toward a busy (or quiet) room, per houseguest already there. */
export const BED_CROWD_PULL = 0.2;

/** How much luck counts against a houseguest's read of a room (a little: who's there and who they are lead). */
export const NOISE_WEIGHT = 0.3;

/** Where `who` sleeps tonight: the HOH room for the HOH, otherwise their own bed's room; undefined when they own no bed (yet). */
export function sleepRoomOf(state: BedsState | undefined, who: EntityId, hoh: EntityId | null | undefined): Room | undefined {
  if (hoh === who) return "hoh-room";
  const bed = state?.owner[who];
  return bed ? roomOfBed(bed) : undefined;
}
