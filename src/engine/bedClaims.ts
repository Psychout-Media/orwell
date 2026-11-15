/**
 * ORW-466 slice 2 - the move-in day bed PICK (design note "Assigned Beds And Themed Bedrooms Design" sec. 2). Pure, no I/O, no shared randomness.
 *
 * - NPCs claim a bed the moment they walk in, in entrance order (early arrivals pick first; between NPCs the first arrival keeps a bed). Each reads every room with a free bed by
 *   who already sleeps there (how they feel about them: first impressions, pre-show ties) and their own nature (a social houseguest likes a busy room, a private one a quiet room; a
 *   strategic one leans harder on being near people they want close), plus a little luck from a side stream (`bedPickNoise`).
 * - The player claims in their own words, resolved in the engine BEFORE the narrator writes (the ORW-419 seam): `parsePlayerBedIntent`.
 * - A taken bed: the player may ask the owner to swap; the owner decides from how they feel about the player and how much they cared about their bed (`decideSwap`).
 * - A player who never picks gets the bed left over at their first bedtime (`BED_RULES.leftoverAtFirstBedtime`, applied in the adapter's `bedThePlayer`).
 *
 * Every rule Ryne has not answered yet (Q3 6/5/5 singles lives in `BEDROOM_LAYOUT`; Q4 leftover; Q5 swaps / when a free bed may be taken) is DATA in `BED_RULES`, so an answer is a one-line change.
 */
import type { EntityId } from "../domain/ids";
import type { Room } from "../domain/house";
import { BEDROOM_LAYOUT, type BedroomSpec } from "./data/bedrooms";
import { BED_CROWD_PULL, NOISE_WEIGHT, claimBed, freeBeds, roomOfBed, roommatesIn, type BedId, type BedsState } from "./beds";

/** The open answers (design note, questions 4 and 5) and the pick's weights, as data. */
export const BED_RULES = {
  /** Q4: a player who never picks gets the bed left over at their first bedtime (as on the show). false: they own no bed until they pick one. */
  leftoverAtFirstBedtime: true,
  /** Q5: when the player may claim a free bed in their own words. "move-in": during the premiere, or any time before they own one (slice 2). "any-time": whenever a bed is free. */
  playerClaimWindow: "move-in" as "move-in" | "any-time",
  /** Q5: the player may ask the owner of a taken bed to swap; false: a taken bed is simply taken. */
  swapsAllowed: true,
  /** Q5: the owner says yes when (affinity to the player above a stranger's) - SWAP_CARE_WEIGHT * (how much more they want their room than the one they would get) >= this. */
  swapAcceptAbove: 0.05,
  swapCareWeight: 1,
  /** How much an NPC's warmth to a room's sleepers counts (per sleeper, on affinity above a stranger's); a strategic nature (mental over social) multiplies it up to 2x. */
  tieWeight: 1,
} as const;

/** What the engine knows about a houseguest for the pick (stats 0..1; affinity is the holder's directed edge). */
export interface BedReader {
  stats: (who: EntityId) => { social: number; mental: number };
  /** `who`'s affinity toward `other`, above a stranger's (the relationship baseline); can be negative. */
  warmth: (who: EntityId, other: EntityId) => number;
}

/** How much `who` wants to sleep in a room where `mates` already sleep. No luck (see `pickBedFor`). */
export function bedRoomScore(who: EntityId, mates: readonly EntityId[], r: BedReader): number {
  const s = r.stats(who);
  const crowd = (s.social - 0.5) * BED_CROWD_PULL * mates.length; // social likes company, private likes quiet
  const strategic = 1 + Math.max(0, Math.min(1, s.mental - s.social));
  const ties = mates.reduce((t, m) => t + Math.max(-0.5, r.warmth(who, m)), 0) * BED_RULES.tieWeight * strategic; // drawn to people they like, away from people they don't
  return crowd + ties;
}

/** The bed `who` would pick now: the first free bed in the room they read best (+ a little luck). Undefined when every bed is taken. Changes nothing. */
export function pickBedFor(
  state: BedsState, who: EntityId, inHouse: ReadonlySet<EntityId>, r: BedReader,
  noise: (who: EntityId, room: Room) => number, layout: readonly BedroomSpec[] = BEDROOM_LAYOUT,
): BedId | undefined {
  const free = freeBeds(state, inHouse, layout);
  let best: { bed: BedId; v: number } | undefined;
  for (const spec of layout) {
    const bed = free.find((b) => roomOfBed(b) === spec.room);
    if (!bed) continue;
    const mates = roommatesIn(state, spec.room, inHouse).filter((m) => m !== who);
    const v = bedRoomScore(who, mates, r) + NOISE_WEIGHT * noise(who, spec.room);
    if (!best || v > best.v) best = { bed, v };
  }
  return best?.bed;
}

/** The first free bed in `room`, or undefined when it is full. */
export function freeBedIn(state: BedsState, room: Room, inHouse: ReadonlySet<EntityId>, layout: readonly BedroomSpec[] = BEDROOM_LAYOUT): BedId | undefined {
  return freeBeds(state, inHouse, layout).find((b) => roomOfBed(b) === room);
}

/**
 * The owner's answer to the player's swap ask. `ownerRoom` is the room they sleep in now, `theirNewRoom` the room they would move to (the player's bed's room, or the best free bed's).
 * Care = how much more they want their own room than the new one (0 when it is the same room: only the spot changes).
 */
export function decideSwap(owner: EntityId, player: EntityId, care: number, r: BedReader): { accept: boolean; care: number; warmth: number } {
  const warmth = r.warmth(owner, player);
  const c = Math.max(0, care);
  return { accept: BED_RULES.swapsAllowed && warmth - BED_RULES.swapCareWeight * c >= BED_RULES.swapAcceptAbove, care: c, warmth };
}

/**
 * Swap `player` into `owner`'s bed. The owner takes the player's bed, or (the player owning none) the free bed `ownerTo`. Returns false and changes nothing when there is nothing to give.
 * Both claims are appended (history is never rewritten).
 */
export function swapBeds(state: BedsState, player: EntityId, owner: EntityId, ownerTo: BedId | undefined, day: number, inHouse: ReadonlySet<EntityId>, layout: readonly BedroomSpec[] = BEDROOM_LAYOUT): boolean {
  const theirs = state.owner[owner];
  if (!theirs) return false;
  const mine = state.owner[player];
  if (mine) {
    state.owner[player] = theirs;
    state.owner[owner] = mine;
    state.claims.push({ who: owner, bed: mine, day, why: "move-in" }, { who: player, bed: theirs, day, why: "move-in" });
    return true;
  }
  if (!ownerTo || !claimBed(state, owner, ownerTo, day, "move-in", inHouse, layout)) return false;
  return claimBed(state, player, theirs, day, "move-in", inHouse, layout);
}

// ---- the player's own words -------------------------------------------------------------------------------------------------------------------------------

export type PlayerBedIntent =
  | { kind: "claim"; room: Room }
  /** a bed near this houseguest (their room) */
  | { kind: "near"; who: EntityId }
  /** ask this houseguest to swap beds (or take their bed) */
  | { kind: "swap"; who: EntityId };

const BED_WORD = /\b(?:bed|beds|bunk|bunks|mattress|cot)\b/;
const CLAIM_VERB = /\b(?:take|taking|took|claim|claiming|grab|grabbing|pick|picking|choose|choosing|chose|want|snag|snagging|dibs|call|calling|go with|going with|settle on|put my (?:bag|bags|stuff|things|suitcase)|drop my (?:bag|bags|stuff|things|suitcase)|throw my (?:bag|bags|stuff|things|suitcase)|this one|that one|mine)\b/;
const SWAP_VERB = /\b(?:swap|swapping|switch|switching|trade|trading|exchange)\b/;
const HEDGE = /\b(?:maybe|perhaps|might|thinking about|wonder|if|unless|don'?t|do not|not|never|won'?t|wouldn'?t|shouldn'?t|should i|later)\b/;
const NEAR = /\b(?:next to|near|beside|by|across from|close to|with|alongside|above|below|under|over)\s+$/;

/** The names a room answers to: its display name, minus a leading "the", and the plain id forms ("bedroom a", "bedroom 1"). */
export function bedroomNames(room: Room, display: string): string[] {
  const d = display.toLowerCase().replace(/^the\s+/, "").trim();
  const letter = /-([a-z])$/.exec(room)?.[1];
  const idx = letter ? letter.charCodeAt(0) - 96 : 0;
  const ord = ["", "first", "second", "third", "fourth"][idx] ?? "";
  return [...new Set([d, room.replace(/-/g, " "), ...(idx ? [`bedroom ${idx}`, `room ${letter}`] : []), ...(ord ? [`${ord} bedroom`] : [])])].filter(Boolean);
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const findName = (clause: string, name: string): number => {
  const m = new RegExp(`\\b${esc(name)}\\b`).exec(clause);
  return m ? m.index : -1;
};

/**
 * Read the player's message for a bed claim of their own. Needs a bed word; hedged / negated phrasing claims nothing; quoted speech is ignored. The LAST clause that claims wins.
 * - names a bedroom ("I'll take the bed by the window in bedroom B") => claim in that room;
 * - "<name>'s bed" or a swap verb + a name ("can I swap beds with X?") => ask that owner to swap (a question is fine here: asking IS the swap);
 * - a bed next to / near a houseguest => a bed in their room.
 */
export function parsePlayerBedIntent(
  text: string,
  rooms: ReadonlyArray<{ room: Room; names: readonly string[] }>,
  people: ReadonlyArray<{ id: EntityId; names: readonly string[] }>,
): PlayerBedIntent | null {
  if (typeof text !== "string" || text.trim() === "") return null;
  const unquoted = text.replace(/"[^"]*"/g, " ").replace(/“[^”]*”/g, " ");
  const clauses = unquoted.match(/[^.!;\n]+[.!;\n?]*/g) ?? [];
  let out: PlayerBedIntent | null = null;
  for (const raw of clauses) {
    const c = ` ${raw.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9' -]+/g, " ").replace(/\s+/g, " ").trim()} `;
    if (!BED_WORD.test(c) || HEDGE.test(c)) continue;
    const named = people.map((p) => ({ id: p.id, at: Math.max(...p.names.map((n) => findName(c, n.toLowerCase()))), names: p.names })).filter((p) => p.at >= 0);
    const possessed = named.find((p) => p.names.some((n) => new RegExp(`\\b${esc(n.toLowerCase())}'s\\s+(?:bed|bunk|spot)\\b`).test(c)));
    if (possessed) { out = { kind: "swap", who: possessed.id }; continue; }
    if (SWAP_VERB.test(c) && named.length > 0) { out = { kind: "swap", who: named[0]!.id }; continue; }
    if (/\?\s*$/.test(raw.trim()) && !/^\s*(?:can|could|may) i (?:take|have|grab|claim)\b/.test(c.trim())) continue; // "is that bed free?" asks, "can I take it?" claims
    if (!CLAIM_VERB.test(c)) continue;
    const room = rooms.find((r) => r.names.some((n) => findName(c, n) >= 0));
    if (room) { out = { kind: "claim", room: room.room }; continue; }
    const near = named.find((p) => NEAR.test(c.slice(0, p.at)));
    if (near) out = { kind: "near", who: near.id };
  }
  return out;
}
