/**
 * ORW-466 - assigned beds (Ryne 2026-11-15). Pure, no I/O, no shared randomness (the caller hands a side stream).
 *
 * Every houseguest owns one sleeping SPOT in one of the three bedrooms: a single bed, or one half of a double that two houseguests share (Ryne: "there could definitely be doubles in the mix").
 * A spot is TAKEN while its owner is still in the house; an evicted owner's spot is free again, and nothing is deleted: the claim history is kept for the season (non-degradation). The HOH sleeps in the
 * HOH room for their week; their own spot waits (`sleepRoomOf`). "Roommates" and "bed partners" are facts (same room, same double), never stored labels (ADR 0002).
 *
 * Ids: a single is `bedroom-a#s1`; the two halves of a double are `bedroom-a#d1:1` and `bedroom-a#d1:2` (the BED is `bedroom-a#d1`).
 */
import type { EntityId } from "../domain/ids";
import type { Room } from "../domain/house";
import { BEDROOM_LAYOUT, type BedroomSpec } from "./data/bedrooms";

/** A sleeping spot (a single bed, or one half of a double). */
export type BedId = string;

export interface BedClaim {
  readonly who: EntityId;
  readonly bed: BedId;
  readonly day: number;
  /** move-in: claimed on move-in day in entrance order; leftover: the spot left over at the player's first bedtime (they never picked one); swap: traded with the spot's owner, who agreed;
   *  move: a later move into a free spot (a goal, a falling-out, an evictee's empty bed). */
  readonly why: "move-in" | "leftover" | "swap" | "move";
}

export interface BedsState {
  /** Each houseguest's spot now. An evicted houseguest keeps the entry (history); their spot reads free through `takenBeds`. */
  owner: Record<EntityId, BedId>;
  /** Every claim, in order. Append-only. */
  claims: BedClaim[];
  /** ORW-466 slice 3: evictees whose empty spot the house has noticed (a public event, once each). Append-only; absent until the first eviction. */
  noticedEmpty?: EntityId[];
  /** ORW-1090: half-of-a-double joins whose sleeper has already woken and reacted (key `bed:sleeper:joiner`). Append-only; absent until the first reaction (saves byte-identical until then). */
  wokeBeside?: string[];
  /** ORW-1179: the spot the player's OWN act last gave them (a claim, an accepted trade, the first-bedtime leftover). The engine puts the player back here if their entry ever differs without such an act. Absent on older saves (adopted from the owner map at the first check). */
  playerBed?: BedId;
}

export const roomOfBed = (spot: BedId): Room => spot.slice(0, spot.lastIndexOf("#")) as Room;
/** The bed a spot belongs to (a double's two halves share it). */
export const bedOfSpot = (spot: BedId): string => spot.replace(/:\d$/, "");
export const isDoubleSpot = (spot: BedId): boolean => /#d\d+:\d$/.test(spot);

export function allBeds(layout: readonly BedroomSpec[] = BEDROOM_LAYOUT): BedId[] {
  return layout.flatMap((r) => [
    ...Array.from({ length: r.singles }, (_, i) => `${r.room}#s${i + 1}`),
    ...Array.from({ length: r.doubles }, (_, i) => [`${r.room}#d${i + 1}:1`, `${r.room}#d${i + 1}:2`]).flat(),
  ]);
}

/** Spots whose owner is still in the house. */
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

/** Who shares `who`'s double (still in the house), if anyone. */
export function bedPartner(state: BedsState, who: EntityId, inHouse: ReadonlySet<EntityId>): EntityId | undefined {
  const mine = state.owner[who];
  if (!inHouse.has(who) || !mine || !isDoubleSpot(mine)) return undefined; // an evictee shares no live bed
  const bed = bedOfSpot(mine);
  return Object.entries(state.owner).find(([other, spot]) => other !== who && inHouse.has(other) && bedOfSpot(spot) === bed)?.[0];
}

/** Claim a free spot. Returns false (and changes nothing) when the spot is not free or does not exist. */
export function claimBed(state: BedsState, who: EntityId, bed: BedId, day: number, why: BedClaim["why"], inHouse: ReadonlySet<EntityId>, layout: readonly BedroomSpec[] = BEDROOM_LAYOUT): boolean {
  if (!inHouse.has(who) || !freeBeds(state, inHouse, layout).includes(bed)) return false; // only someone in the house can claim, and only a free spot
  state.owner[who] = bed;
  state.claims.push({ who, bed, day, why });
  return true;
}

/** How much a houseguest dislikes starting the season in half of an empty double (a stranger could take the other half): small, so they take a single when one is free. */
export const EMPTY_DOUBLE_PENALTY = 0.1;
/** Above this feeling for someone, sharing their double beats a single (a pre-show tie, an instant bond). */
export const SHARE_DOUBLE_AT = 0.65;

/**
 * Which spot `who` takes in `room`: half of a double next to someone they like enough (`share(who, other)` > SHARE_DOUBLE_AT; the best such partner), else a single, else half of an empty double,
 * else half of a double next to whoever is there. Pure.
 */
export function pickSpot(state: BedsState, who: EntityId, room: Room, inHouse: ReadonlySet<EntityId>, share: (who: EntityId, other: EntityId) => number, layout: readonly BedroomSpec[] = BEDROOM_LAYOUT): BedId | undefined {
  const free = freeBeds(state, inHouse, layout).filter((b) => roomOfBed(b) === room);
  if (!free.length) return undefined;
  const partnerOf = (spot: BedId): EntityId | undefined =>
    Object.entries(state.owner).find(([o, s]) => inHouse.has(o) && s !== spot && bedOfSpot(s) === bedOfSpot(spot))?.[0];
  let best: { spot: BedId; v: number } | undefined;
  for (const spot of free) {
    let v = 0;
    if (isDoubleSpot(spot)) {
      const p = partnerOf(spot);
      v = p === undefined ? -EMPTY_DOUBLE_PENALTY : share(who, p) - SHARE_DOUBLE_AT;
    }
    if (!best || v > best.v) best = { spot, v };
  }
  return best!.spot;
}

/** How much a social (or private) nature pulls toward a busy (or quiet) room, per houseguest already there. */
export const BED_CROWD_PULL = 0.2;
/** How much luck counts against a houseguest's read of a room (a little: who's there and who they are lead). */
export const NOISE_WEIGHT = 0.3;

/**
 * Move-in day: the houseguests in `order` (entrance order, early arrivals first - as on the show) each claim a spot. `score(who, room, roommatesSoFar)` is the engine's read of how much `who` wants
 * that room (who is already in it, their nature); `noise` is a side-stream draw in [0,1) per (who, room) that breaks ties and adds a little luck; `share(who, other)` is how much they would share a
 * double with `other`. Full rooms are skipped. Anyone in `skip` (the player, who picks for themselves) claims nothing here.
 */
export function moveInBeds(
  order: readonly EntityId[],
  score: (who: EntityId, room: Room, roommatesSoFar: readonly EntityId[]) => number,
  noise: (who: EntityId, room: Room) => number,
  share: (who: EntityId, other: EntityId) => number,
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
    if (!best) break; // every spot is taken
    claimBed(state, who, pickSpot(state, who, best.room, everyone, share, layout)!, opts.day ?? 1, "move-in", everyone, layout);
  }
  return state;
}

/** Where `who` sleeps tonight: the HOH room for the HOH, otherwise their own spot's room; undefined when they own no spot (yet). */
export function sleepRoomOf(state: BedsState | undefined, who: EntityId, hoh: EntityId | null | undefined): Room | undefined {
  if (hoh === who) return "hoh-room";
  const bed = state?.owner[who];
  return bed ? roomOfBed(bed) : undefined;
}

/**
 * ORW-1153: the narrator's ONE bed fact. Per room (by the name `roomName` gives it), every single and every half of a double on its own line item with its owner or "free", and the house-wide count of
 * free spots. A double's halves are listed separately ("double 1, half 1 / half 2") so a half-empty double reads as exactly that; a houseguest still racing has no spot, so appears nowhere here. Pure:
 * owners still in the house hold a spot, an evictee's spot reads free (`takenBeds`).
 */
export function bedTable(
  state: BedsState, inHouse: ReadonlySet<EntityId>, roomName: (room: Room) => string, label: (who: EntityId) => string,
  layout: readonly BedroomSpec[] = BEDROOM_LAYOUT,
): { rooms: string[]; free: number; total: number; freeByRoom: Record<string, string[]> } {
  const holder = new Map<BedId, EntityId>();
  for (const [who, spot] of Object.entries(state.owner)) if (inHouse.has(who)) holder.set(spot, who);
  const who = (spot: BedId): string => { const h = holder.get(spot); return h === undefined ? "free" : label(h); };
  const freeByRoom: Record<string, string[]> = {};
  let free = 0; let total = 0;
  const rooms = layout.map((r) => {
    const items: string[] = [];
    const open: string[] = [];
    const note = (spot: BedId, text: string): void => { total++; if (!holder.has(spot)) { free++; open.push(text); } };
    for (let i = 1; i <= r.singles; i++) { const spot = `${r.room}#s${i}`; items.push(`single ${i}: ${who(spot)}`); note(spot, `single ${i}`); }
    for (let i = 1; i <= r.doubles; i++) {
      for (const h of [1, 2]) { const spot = `${r.room}#d${i}:${h}`; items.push(`double ${i} half ${h}: ${who(spot)}`); note(spot, `double ${i} half ${h}`); }
    }
    freeByRoom[r.room] = open;
    return `${roomName(r.room)} (${r.singles} single${r.singles === 1 ? "" : "s"}, ${r.doubles} double${r.doubles === 1 ? "" : "s"}; each single sleeps one, each double two): ${items.join("; ")}`;
  });
  return { rooms, free, total, freeByRoom };
}

/** ORW-1153: what is free in one room, in words, for a refusal ("every spot there is taken" / "free there: double 1 half 2"). */
export function freeInRoomWords(free: readonly string[]): string { return free.length ? `free there: ${free.join(", ")}` : "nothing is free there"; }
