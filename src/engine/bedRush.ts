/**
 * ORW-672 / feature 0201 - THE BED RUSH. Pure, no I/O, no shared randomness (the adapter hands in side-stream luck keyed `${seed}:bed-rush:...`).
 *
 * Nobody claims a bed before the champagne circle closes. Then everyone is released at once and the house races for the bedrooms: a claim needs a houseguest to actually REACH the room, and WHEN
 * they reach it comes from who they are (speed, eagerness, how badly they want a particular roommate), how far they have to go and a little luck (`arrivalTick`). WHICH bed they take stays
 * the ORW-466 pick (`pickBedFor`, bedClaims.ts). The rush resolves in a few engine ticks (one per advanceGame).
 *
 * SAFETY (the player is never left without a real choice): while the player has no bed, an NPC claim that would leave fewer than `floorSpots` free spots, or free spots in fewer than `floorRooms`
 * rooms, waits (`claimKeepsFloor`). It resumes the moment the player claims, or at their first bedtime.
 */
import type { Room } from "../domain/house";

export const BED_RUSH = {
  /** The race lasts this many ticks (arrivals land on ticks 1..ticks). */
  ticks: 4,
  /** After the race, a held houseguest waits this many more ticks before advanceGame stops running the rush (they stay held until the player claims or first goes to bed). */
  graceTicks: 2,
  /** At least this many free spots stay open for the player while they have not claimed... */
  floorSpots: 4,
  /** ...spread over at least this many rooms. */
  floorRooms: 2,
  /** How the arrival time mixes (weights sum to 1; lower time = earlier). */
  weights: { speed: 0.35, eagerness: 0.25, distance: 0.25, luck: 0.15 },
} as const;

/** What the engine knows about one runner, each 0..1 (higher speed / eagerness = earlier; higher distance = later). */
export interface RushRunner { speed: number; eagerness: number; distance: number; luck: number }

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/** The tick (1..BED_RUSH.ticks) on which this runner reaches their room. Deterministic from the inputs. */
export function arrivalTick(r: RushRunner, w: typeof BED_RUSH.weights = BED_RUSH.weights): number {
  const t = w.speed * (1 - clamp01(r.speed)) + w.eagerness * (1 - clamp01(r.eagerness)) + w.distance * clamp01(r.distance) + w.luck * clamp01(r.luck);
  return 1 + Math.min(BED_RUSH.ticks - 1, Math.floor(clamp01(t) * BED_RUSH.ticks));
}

/** Free spots per room right now -> would one more claim in `room` still leave the player the floor (spots and rooms)? */
export function claimKeepsFloor(freeByRoom: Readonly<Record<string, number>>, room: Room): boolean {
  let spots = 0; let rooms = 0;
  for (const [r, n] of Object.entries(freeByRoom)) {
    const left = r === room ? n - 1 : n;
    spots += left;
    if (left > 0) rooms += 1;
  }
  return spots >= BED_RUSH.floorSpots && rooms >= BED_RUSH.floorRooms;
}

/** The persisted rush (live season state). Append-only `log`, monotonic `tick`; a restore resumes from exactly here. */
export interface BedRushState {
  /** Ticks run so far (monotonic). */
  tick: number;
  /** Per NPC: the room they are racing for and the tick they reach it (decided once, at the release). */
  plan: Record<string, { room: Room; at: number }>;
  /** Every claim the rush made: who, which room, on which tick. Append-only. */
  log: Array<{ tick: number; who: string; room: Room }>;
  /** Every NPC has a bed. */
  done: boolean;
  /** The race and its grace are over; advanceGame no longer runs the rush (anyone still held waits for the player's claim or first bedtime). */
  windowEnded?: boolean;
}
