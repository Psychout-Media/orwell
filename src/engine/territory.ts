/**
 * ORW-561 / spec 0176 (Theme 3 slice 10, part 2): TERRITORY. A house sorts itself by where people spend their hours: the kitchen crowd, the backyard set, the pair who share a bedroom.
 * The engine keeps a hidden TENURE map (hours per houseguest per room, only ever growing) and reads two soft things from it: a mild pull toward people who share your top room when you pick who to
 * spend an hour with, and a small capped nudge on a pair's MUTUAL bond (roommates, shared top room) where blocs and NPC alliances read it. It never decides an outcome and never creates a bond
 * from nothing: the floors and caps of the alliance layer are untouched.
 *
 * VAULT-CLASS and ENGINE-ONLY (listed in the dependency-cruiser engine denylist): tenure, top rooms and regulars never reach a projection, prompt, tool result or log. The HOH room is recorded like
 * any room (slice 11 reads that time for the court); no courting weight lives here. Pure: no rng, no I/O.
 *
 * Seam note: a "cliquey" house culture could scale `TERRITORY.*` later (a dial on the pull and the nudge); no culture lean reads it yet.
 */
import type { EntityId } from "../domain/ids";
import type { Room } from "../domain/house";
import { roomOfBed, type BedsState } from "./beds";

export type Tenure = Record<EntityId, Partial<Record<Room, number>>>;

export const TERRITORY = {
  /** Hours in a room before it can be someone's "top room" (a newcomer has no territory yet). */
  MIN_HOURS: 4,
  /** Added to the partner score (affinity + roll x 0.3) for someone who shares the holder's top room. No extra draw. */
  PARTNER_PULL: 0.06,
  /** Added to a pair's mutual bond when they share a bedroom / share a top room; the sum is capped. */
  ROOMMATE_NUDGE: 0.04,
  SHARED_ROOM_NUDGE: 0.02,
  NUDGE_CAP: 0.05,
} as const;

/** Rooms that are nobody's hangout: the Diary Room is private, and the HOH room is a court (slice 11), not a regulars' spot. */
const NOT_A_HANGOUT: ReadonlySet<Room> = new Set<Room>(["diary-room", "hoh-room"]);

/** Add one hour (or `hours`) for `who` in `room`. Monotonic: a non-positive or non-finite amount does nothing. Mutates and returns the map. */
export function bumpTenure(t: Tenure, who: EntityId, room: Room, hours = 1): Tenure {
  if (!(hours > 0) || !Number.isFinite(hours)) return t;
  const mine = (t[who] ??= {});
  mine[room] = (mine[room] ?? 0) + hours;
  return t;
}

/** The room `who` has spent the most hours in (ties by room name), among hangout rooms, once it clears MIN_HOURS; else undefined. */
export function topRoomOf(t: Tenure | undefined, who: EntityId): Room | undefined {
  const mine = t?.[who];
  if (!mine) return undefined;
  let best: Room | undefined, bestH = 0;
  for (const room of Object.keys(mine).sort() as Room[]) {
    if (NOT_A_HANGOUT.has(room)) continue;
    const h = mine[room] ?? 0;
    if (h > bestH) { best = room; bestH = h; }
  }
  return best !== undefined && bestH >= TERRITORY.MIN_HOURS ? best : undefined;
}

/** The houseguests whose top room is `room` (sorted). Engine-only. */
export function regularsOf(t: Tenure | undefined, room: Room, among?: Iterable<EntityId>): EntityId[] {
  const pool = among ? [...among] : Object.keys(t ?? {});
  return pool.filter((id) => topRoomOf(t, id) === room).sort();
}

/** Of `others`, the ones who share `who`'s top room. Empty when `who` has no top room yet. */
export function sharedTopRoom(t: Tenure | undefined, who: EntityId, others: Iterable<EntityId>): EntityId[] {
  const mine = topRoomOf(t, who);
  if (mine === undefined) return [];
  return [...others].filter((o) => o !== who && topRoomOf(t, o) === mine).sort();
}

/** The small additive on a pair's MUTUAL bond: roommates and a shared top room, summed and capped at NUDGE_CAP. Symmetric; 0 for a pair with neither. */
export function territoryNudge(t: Tenure | undefined, beds: BedsState | undefined, a: EntityId, b: EntityId): number {
  if (a === b) return 0;
  let n = 0;
  const ba = beds?.owner[a], bb = beds?.owner[b];
  if (ba && bb && roomOfBed(ba) === roomOfBed(bb)) n += TERRITORY.ROOMMATE_NUDGE;
  const ra = topRoomOf(t, a);
  if (ra !== undefined && ra === topRoomOf(t, b)) n += TERRITORY.SHARED_ROOM_NUDGE;
  return Math.min(TERRITORY.NUDGE_CAP, n);
}

/** Words only, for the post-season look-back: the crowds that formed, never a count. */
const CROWD_WORDS: Partial<Record<Room, string>> = {
  kitchen: "the kitchen crowd", backyard: "the backyard set", "living-room": "the living-room regulars", "dining-room": "the dining-table regulars",
  "storage-room": "the storage-room whisperers", hallway: "the hallway loiterers",
};
export function describeTerritory(t: Tenure | undefined): string[] {
  const rooms = new Map<Room, number>();
  for (const id of Object.keys(t ?? {})) { const r = topRoomOf(t, id); if (r) rooms.set(r, (rooms.get(r) ?? 0) + 1); }
  return [...rooms.entries()].filter(([r, n]) => n >= 2 && CROWD_WORDS[r]).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).map(([r]) => CROWD_WORDS[r]!);
}
