/**
 * ORW-566 / spec 0183 (Theme 3 slice 7, parts a and b) - PRIVATE HABITS AND GROUP IDENTITY, the engine-side FLOOR.
 *
 * Two close allies keep a spot of their own and meet there in the hours after a ceremony; an alliance is named from the house's OWN authored
 * words (the nickname of the room it formed in, else a ritual name, else the head of the running joke) and keeps today's name when the house
 * has none. Everything here is pure and deterministic (keyed `agendaRoll`, no shared rng, no I/O). VAULT-CLASS: `live.groupIdentity` and the
 * habit stamp on a scene are engine-only and never cross to any surface; the player reads people, never a roster of who meets where.
 *
 * No list in this module feeds a pick: a spot is the best-scoring room by a keyed roll (a sort over the house's own rooms), words come from
 * the house's authored culture, and the plain room reference is the offline floor.
 */
import type { EntityId } from "../domain/ids";
import type { Room } from "../domain/house";
import { isPrivateRoom, WALKABLE_ROOMS } from "../domain/house";
import { agendaRoll } from "./agenda";
import { ALLIANCE } from "./alliances";
import type { HouseCulture } from "./npcMindsAuthored";

export const GROUP_IDENTITY = {
  /** The mutual-bond bar for a close pair, as a RATIO of the bar an NPC ally joins at (`ALLIANCE.npcAllyFloor`): a pair that is not allied but is this tight keeps a habit too. The loyalty dial lowers it for a loyal house. */
  habitFloor: 1.1,
  /** How many in-game hours after a ceremony beat resolves the debrief window stays open. */
  windowHours: 3,
  /** The words of a running joke that may head an alliance name (head words only, never the whole line). */
  jokeHeadWords: 3,
} as const;

/** One stored identity: write-once, monotonic, engine-only. `kind` says what it is a floor for. */
export interface GroupIdentityEntry { name?: string; spot?: string; kind: "debrief" | "alliance"; since: number }
export type GroupIdentityStore = Record<string, GroupIdentityEntry>;

/** The stable key of a pair (sorted ids), used for the habit roll, the scene stamp and the identity store. */
export const pairKey = (a: EntityId, b: EntityId): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** What the bond reader must answer: swap this seam for the shared bond reader when it lands (ORW-561 follow-up). */
export interface PairCloseness {
  /** They share an alliance. */
  allied(a: EntityId, b: EntityId): boolean;
  /** The weaker direction of the pair's bond, (trust + affinity) / 2, 0..1. */
  mutual(a: EntityId, b: EntityId): number;
}

/** The mutual-bond bar for a habit, given the culture's loyalty dial (1 = none): a loyal house keeps habits at a lower bond. */
export const habitBar = (loyaltyMult = 1): number => (ALLIANCE.npcAllyFloor * GROUP_IDENTITY.habitFloor) / Math.max(1e-6, loyaltyMult);

/** Close allies: they share an alliance, or their weaker-direction bond clears the habit bar. */
export function isClosePair(r: PairCloseness, a: EntityId, b: EntityId, loyaltyMult = 1): boolean {
  return r.allied(a, b) || r.mutual(a, b) >= habitBar(loyaltyMult);
}

/** Is `now` inside the debrief window that opens when a ceremony beat resolves at `last`? (undefined = no ceremony yet = closed.) */
export function inDebriefWindow(now: number, last: number | undefined): boolean {
  return last !== undefined && now >= last && now - last <= GROUP_IDENTITY.windowHours;
}

/**
 * The pair's spot: one PUBLIC room, fixed per pair for the season (a keyed roll per room, best score wins). A room the house has already given a
 * nickname is preferred, so a pair's habit lives in the house's own words; with no culture it is the best-scoring public room.
 */
export function habitRoom(seed: number, key: string, culture: HouseCulture | undefined): Room {
  const score = (r: Room): number => agendaRoll(seed, key, `habit-room:${r}`);
  const publicRooms = WALKABLE_ROOMS.filter((r) => !isPrivateRoom(r));
  const named = publicRooms.filter((r) => culture?.spots.some((s) => s.room === r));
  const pool = named.length > 0 ? named : publicRooms;
  return [...pool].sort((a, b) => score(b) - score(a) || a.localeCompare(b))[0]!;
}

/** The house's own nickname for a room, if it has authored one. */
export const nicknameOf = (culture: HouseCulture | undefined, room: Room | undefined): string | undefined =>
  room === undefined ? undefined : culture?.spots.find((s) => s.room === room)?.nickname;

/**
 * An alliance's name from the house's own authored words: the nickname of the room it formed in, else a ritual name, else the head words of the
 * running joke. `taken` names are skipped. Undefined when the house has authored nothing usable: the caller keeps today's name unchanged.
 */
export function allianceNameFromHouse(seed: number, key: string, culture: HouseCulture | undefined, formedIn: Room | undefined, taken: ReadonlySet<string>): { name: string; spot?: string } | undefined {
  if (!culture) return undefined;
  const free = (n: string | undefined): n is string => !!n && !taken.has(n);
  const spot = nicknameOf(culture, formedIn);
  if (free(spot)) return { name: spot, spot };
  const ritual = [...culture.rituals].sort((a, b) => agendaRoll(seed, key, `ritual-name:${b.name}`) - agendaRoll(seed, key, `ritual-name:${a.name}`) || a.name.localeCompare(b.name)).find((r) => free(r.name));
  if (ritual) return { name: ritual.name };
  const head = culture.runningJoke?.split(/\s+/).filter(Boolean).slice(0, GROUP_IDENTITY.jokeHeadWords).join(" ").replace(/[.,;:!?]+$/, "");
  if (free(head) && head) return { name: head };
  return undefined;
}

/** Write-once into the store (never overwritten, never removed: monotonic). Returns true when it wrote. */
export function noteIdentity(store: GroupIdentityStore, id: string, entry: GroupIdentityEntry): boolean {
  if (store[id]) return false;
  store[id] = entry;
  return true;
}
