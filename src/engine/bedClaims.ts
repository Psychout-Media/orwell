/**
 * ORW-466 slice 2 - the move-in day bed PICK (design note "Assigned Beds And Themed Bedrooms Design" sec. 2). Pure, no I/O, no shared randomness.
 *
 * - NPCs claim a bed the moment they walk in, in entrance order (early arrivals pick first; between NPCs the first arrival keeps a bed). Each reads every room with a free bed by
 *   who already sleeps there (how they feel about them: first impressions, pre-show ties) and their own nature (a social houseguest likes a busy room, a private one a quiet room; a
 *   strategic one leans harder on being near people they want close), plus a little luck from a side stream (`bedPickNoise`).
 * - The player claims in their own words, resolved in the engine BEFORE the narrator writes (the ORW-419 seam): `parsePlayerBedIntent`.
 * - Doubles (Ryne: "there could definitely be doubles in the mix"; the layout and spot ids are the Auditor's, `beds.ts`): everyone claims ONE SPOT; for half of a double the bedmate counts far more
 *   than the room - a strong pull toward someone they like, a stronger aversion to someone they don't (`BED_RULES.bedmatePull` / `bedmateAversion`), and sharing a bed at all has a bar to clear.
 * - A taken bed: the player may ask the owner to swap; the owner decides from how they feel about the player and how much they cared about their spot (`decideSwap`). Half of a double: only the
 *   spot's owner decides, and the other half's sleeper has a say too (`BED_RULES.halfDoublePartnerVeto`, Ryne 2026-11-15).
 * - A player who never picks gets the bed left over at their first bedtime (`BED_RULES.leftoverAtFirstBedtime`, applied in the adapter's `bedThePlayer`).
 *
 * Every rule Ryne has not answered yet (Q3 6/5/5 singles lives in `BEDROOM_LAYOUT`; Q4 leftover; Q5 swaps / when a free bed may be taken) is DATA in `BED_RULES`, so an answer is a one-line change.
 */
import type { EntityId } from "../domain/ids";
import type { Room } from "../domain/house";
import { stripNonActs } from "./playerText";
import { BEDROOM_LAYOUT, type BedroomSpec } from "./data/bedrooms";
import { BED_CROWD_PULL, EMPTY_DOUBLE_PENALTY, NOISE_WEIGHT, SHARE_DOUBLE_AT, pickSpot, bedOfSpot, claimBed, freeBeds, isDoubleSpot, roomOfBed, roommatesIn, type BedId, type BedsState } from "./beds";

/** The open answers (design note, questions 4 and 5) and the pick's weights, as data. */
export const BED_RULES = {
  /** Q4: a player who never picks gets the bed left over at their first bedtime (as on the show). false: they own no bed until they pick one. */
  leftoverAtFirstBedtime: true,
  /** Q5: when the player may claim a free bed in their own words. "move-in": during the premiere, or any time before they own one (slice 2). "any-time": whenever a bed is free (slice 3, Ryne 2026-11-15: "You are also welcome to swap or change beds as people get evicted. You don't need
   *  permission if they are no longer present."): a free spot (an evictee's included) is taken without asking anyone; an occupied one only by a swap its owner (and a double's other half) agrees to. */
  playerClaimWindow: "any-time" as "move-in" | "any-time",
  /** Q5: the player may ask the owner of a taken bed to swap; false: a taken bed is simply taken. */
  swapsAllowed: true,
  /** Q5: the owner says yes when (affinity to the player above a stranger's) - SWAP_CARE_WEIGHT * (how much more they want their room than the one they would get) >= this. */
  swapAcceptAbove: 0.05,
  swapCareWeight: 1,
  /** Half of a double - the `share` handed to the Auditor's `pickSpot` (shares only above SHARE_DOUBLE_AT 0.65 on the affinity scale): a stranger's level plus the would-be bedmate's warmth times this
   *  (a liked bedmate pulls hard: with 3, affinity about 0.39 or more is enough to share)... */
  bedmatePull: 3,
  /** ...and times this for a bedmate they are cold to (aversion is stronger than pull, so that half ranks below a single and an empty double). */
  bedmateAversion: 6,
  /** Q5 answered (Ryne 2026-11-15: "Yeah I think they should get a say. It's like basic logic and human decency. Swapping should be a shared trade. You can't steal."): swapping into
   *  half of a double needs the spot owner's yes AND the other half's sleeper's (they get a say). A spot freed by an eviction needs nobody's ("You don't need permission if they are no longer present"). */
  halfDoublePartnerVeto: true,
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

/** How much `who` would share a double with `other` (the `share` for `pickSpot`, on the affinity scale): the bedmate counts far more than the room, both ways. */
export function bedmateShare(r: BedReader, baseline: number): (who: EntityId, other: EntityId) => number {
  return (who, other) => { const w = r.warmth(who, other); return baseline + (w >= 0 ? BED_RULES.bedmatePull : BED_RULES.bedmateAversion) * w; };
}

/** Who sleeps in the other half of `spot`'s double (in the house, not `who`), if anyone. */
export function otherHalf(state: BedsState, spot: BedId, inHouse: ReadonlySet<EntityId>, who?: EntityId): EntityId | undefined {
  if (!isDoubleSpot(spot)) return undefined;
  const bed = bedOfSpot(spot);
  return Object.entries(state.owner).find(([o, s]) => o !== who && inHouse.has(o) && s !== spot && bedOfSpot(s) === bed)?.[0];
}

/**
 * How much `who` wants this sleeping spot: the room (who else sleeps there, their nature) plus, for half of a double, the bedmate on the `share` scale (above SHARE_DOUBLE_AT draws them in, below
 * it pushes them off - the bedmate weighs far more than the room). `away` = sleepers to leave out (a swap's other party). No luck.
 */
export function spotScore(state: BedsState, who: EntityId, spot: BedId, inHouse: ReadonlySet<EntityId>, r: BedReader, share: (who: EntityId, other: EntityId) => number, away: ReadonlySet<EntityId> = new Set()): number {
  const mates = roommatesIn(state, roomOfBed(spot), inHouse).filter((m) => m !== who && !away.has(m));
  let v = bedRoomScore(who, mates, r);
  if (isDoubleSpot(spot)) {
    const mate = otherHalf(state, spot, inHouse, who);
    v += mate === undefined || away.has(mate) ? -EMPTY_DOUBLE_PENALTY : share(who, mate) - SHARE_DOUBLE_AT;
  }
  return v;
}

/**
 * The spot `who` would pick now: in each room with a free spot, the spot the Auditor's `pickSpot` gives them (`share` decides half a double vs a single); the room is read by its sleepers and
 * that spot's bedmate (`spotScore`) plus a little luck. Undefined when every spot is taken. Changes nothing.
 */
export function pickBedFor(
  state: BedsState, who: EntityId, inHouse: ReadonlySet<EntityId>, r: BedReader, share: (who: EntityId, other: EntityId) => number,
  noise: (who: EntityId, room: Room) => number, layout: readonly BedroomSpec[] = BEDROOM_LAYOUT,
): BedId | undefined {
  let best: { bed: BedId; v: number } | undefined;
  for (const spec of layout) {
    const spot = pickSpot(state, who, spec.room, inHouse, share, layout);
    if (!spot) continue;
    const v = spotScore(state, who, spot, inHouse, r, share) + NOISE_WEIGHT * noise(who, spec.room);
    if (!best || v > best.v) best = { bed: spot, v };
  }
  return best?.bed;
}

/** The player's spot in `room`: the kind they asked for when free ("double" / "single"), else a single first (no stranger's double half unasked), else any free spot. Undefined when the room is full. */
export function freeBedIn(state: BedsState, room: Room, inHouse: ReadonlySet<EntityId>, prefer?: "single" | "double", layout: readonly BedroomSpec[] = BEDROOM_LAYOUT): BedId | undefined {
  const free = freeBeds(state, inHouse, layout).filter((b) => roomOfBed(b) === room);
  const kind = (d: boolean) => free.find((b) => isDoubleSpot(b) === d);
  return (prefer === "double" ? kind(true) : kind(false)) ?? free[0];
}

/**
 * The owner's answer to the player's swap ask. `ownerRoom` is the room they sleep in now, `theirNewRoom` the room they would move to (the player's bed's room, or the best free bed's).
 * Care = how much more they want their own room than the new one (0 when it is the same room: only the spot changes).
 */
export function decideSwap(owner: EntityId, player: EntityId, care: number, r: BedReader, halfPartner?: EntityId): { accept: boolean; care: number; warmth: number; vetoedBy?: EntityId } {
  const warmth = r.warmth(owner, player);
  const c = Math.max(0, care);
  const yes = BED_RULES.swapsAllowed && warmth - BED_RULES.swapCareWeight * c >= BED_RULES.swapAcceptAbove;
  if (yes && BED_RULES.halfDoublePartnerVeto && halfPartner !== undefined && r.warmth(halfPartner, player) < BED_RULES.swapAcceptAbove) return { accept: false, care: c, warmth, vetoedBy: halfPartner };
  return { accept: yes, care: c, warmth };
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
    state.claims.push({ who: owner, bed: mine, day, why: "swap" }, { who: player, bed: theirs, day, why: "swap" });
    return true;
  }
  if (!ownerTo || !claimBed(state, owner, ownerTo, day, "swap", inHouse, layout)) return false;
  return claimBed(state, player, theirs, day, "swap", inHouse, layout);
}

// ---- later moves (slice 3) ------------------------------------------------------------------------------------------------------------------------------------

/**
 * ORW-466 slice 3 - later moves, as data. An NPC moves only for a GOAL (toward an ally or a showmance, away from someone who betrayed them, or into a spot an evicted houseguest left), only into a FREE
 * spot, and rarely: the house gets one seeded roll per in-game day (`dailyChance`), at most `maxPerDay` goal moves on a day it hits, and the new spot must beat the old one by more than `careAbove`.
 * No season cap. Every magnitude of the relationship folds lives here (the B59 rule: never an inline number at a call site).
 */
export const BED_MOVES = {
  /** The chance, per in-game day, that anyone moves at all (one roll per day, side stream `${seed}:bed-moves:${day}`). */
  dailyChance: 0.25,
  /** Goal moves on one day, at most. */
  maxPerDay: 1,
  /** How much better (goal-weighted spot value) the new spot must be before anyone bothers to move. */
  careAbove: 0.3,
  /** Per goal person (a named-alliance co-member, the showmance) sleeping in the new spot's room. */
  towardPull: 0.6,
  /** Per betrayer sleeping in the spot's room (a recorded betrayal against the mover). */
  awayPush: 0.8,
  /** Without a seeded showmance, the strongest MUTUAL affinity counts as one only at or above this. */
  showmanceAffinity: 0.7,
  /** Moving away from someone: a tiny slight on their edge toward the mover. */
  slight: { affinity: -0.02, trust: -0.01 },
  /** Moving toward someone: a tiny warm signal on their edge toward the mover. */
  signal: { affinity: 0.015 },
  /** Move-in day: the spot they wanted most was taken by an earlier arrival and they wanted it this much more than what they got: a tiny grudge toward the taker. */
  lostBedGrudgeAbove: 0.3,
  lostBedGrudge: { affinity: -0.015 },
} as const;

/** Who an NPC wants to sleep near (`toward`) and away from (`away`). */
export interface BedGoals { toward: readonly EntityId[]; away: readonly EntityId[] }

export interface BedMove {
  who: EntityId;
  from: BedId;
  to: BedId;
  /** Goal people the move brings them in with (the new room's / the new double's), and the ones it leaves behind (the old room's betrayers, the old bedmate). */
  joined: EntityId[];
  left: EntityId[];
  /** The evicted houseguest whose spot this was, when it was one. */
  freedBy?: EntityId;
}

/** `who`'s goal-weighted value of `spot`: the spot itself (`spotScore`) plus the goal people in that room. */
function goalValue(state: BedsState, who: EntityId, spot: BedId, inHouse: ReadonlySet<EntityId>, r: BedReader, share: (who: EntityId, other: EntityId) => number, g: BedGoals): number {
  const mates = roommatesIn(state, roomOfBed(spot), inHouse).filter((m) => m !== who);
  const count = (xs: readonly EntityId[]) => xs.filter((x) => mates.includes(x)).length;
  return spotScore(state, who, spot, inHouse, r, share) + BED_MOVES.towardPull * count(g.toward) - BED_MOVES.awayPush * count(g.away);
}

/**
 * The one goal move worth making now, if any (the mover who gains the most over `careAbove`). Free spots only; a move needs a reason (a goal person joined or left behind, or an evicted houseguest's
 * spot) - a vague "slightly nicer bed" never moves anyone. Pure; changes nothing. Ties break by id order.
 */
export function planGoalMove(
  state: BedsState, movers: readonly EntityId[], inHouse: ReadonlySet<EntityId>, r: BedReader, share: (who: EntityId, other: EntityId) => number,
  goalsOf: (who: EntityId) => BedGoals, layout: readonly BedroomSpec[] = BEDROOM_LAYOUT,
): BedMove | undefined {
  const free = freeBeds(state, inHouse, layout);
  if (!free.length) return undefined;
  const lastOwner = (spot: BedId): EntityId | undefined => Object.entries(state.owner).find(([o, s]) => s === spot && !inHouse.has(o))?.[0];
  let best: { move: BedMove; gain: number } | undefined;
  for (const who of [...movers].sort()) {
    const from = state.owner[who];
    if (!from || !inHouse.has(who)) continue;
    const g = goalsOf(who);
    const cur = goalValue(state, who, from, inHouse, r, share, g);
    const oldMates = roommatesIn(state, roomOfBed(from), inHouse).filter((m) => m !== who);
    const oldMate = otherHalf(state, from, inHouse, who);
    for (const to of free) {
      const gain = goalValue(state, who, to, inHouse, r, share, g) - cur;
      if (gain <= BED_MOVES.careAbove || (best && gain <= best.gain)) continue;
      const newMates = roomOfBed(to) === roomOfBed(from) ? oldMates : roommatesIn(state, roomOfBed(to), inHouse).filter((m) => m !== who);
      const newMate = otherHalf(state, to, inHouse, who);
      const joined = g.toward.filter((x) => (newMates.includes(x) && !oldMates.includes(x)) || (x === newMate && x !== oldMate));
      const left = [...new Set([...g.away.filter((x) => oldMates.includes(x) && !newMates.includes(x)), ...(oldMate !== undefined && oldMate !== newMate ? [oldMate] : [])])];
      const freedBy = lastOwner(to);
      if (!joined.length && !g.away.some((x) => left.includes(x)) && freedBy === undefined) continue; // no goal behind it
      best = { move: { who, from, to, joined, left, ...(freedBy !== undefined ? { freedBy } : {}) }, gain };
    }
  }
  return best?.move;
}

/** Make the move (a free spot only; appended as a "move" claim). False and nothing changed when the spot is not free. */
export function applyMove(state: BedsState, m: BedMove, day: number, inHouse: ReadonlySet<EntityId>, layout: readonly BedroomSpec[] = BEDROOM_LAYOUT): boolean {
  return claimBed(state, m.who, m.to, day, "move", inHouse, layout);
}

// ---- the player's own words -------------------------------------------------------------------------------------------------------------------------------

export type PlayerBedIntent =
  | { kind: "claim"; room: Room; prefer?: "single" | "double" }
  /** a bed near this houseguest (their room) */
  | { kind: "near"; who: EntityId }
  /** ask this houseguest to swap beds (or take their bed) */
  | { kind: "swap"; who: EntityId };

const BED_WORD = /\b(?:bed|beds|bunk|bunks|mattress|cot|double|doubles|half of|other half|spot|(?:a|the|an) (?:queen|king))\b/; // ORW-1010: "half of the double in <room>" names no "bed" yet is a claim
const CLAIM_VERB = /\b(?:take|taking|took|claim|claiming|grab|grabbing|pick|picking|choose|choosing|chose|want|snag|snagging|dibs|call|calling|go with|going with|settle on|sleep(?:ing)? (?:in|on)|put my (?:bag|bags|stuff|things|suitcase)|drop my (?:bag|bags|stuff|things|suitcase)|throw my (?:bag|bags|stuff|things|suitcase)|this one|that one|mine)\b/;
const SWAP_VERB = /\b(?:swap|swapping|switch|switching|trade|trading|exchange)\b/;
const HEDGE = /\b(?:maybe|perhaps|might|thinking about|wonder|if|unless|don'?t|do not|not|never|won'?t|wouldn'?t|shouldn'?t|should i|later|can'?t|cannot|couldn'?t|refuse|refused|refusing|decided against|decide against|already|(?:i )?(?:type|typed)|ooc)\b/;
const FIRST_PERSON = /\b(?:i|im|i'm|i'll|ill|i'd|id|me|my|we|let's|lets)\b/;
const POSSESSED_ASK = /\b(?:want|wanna|take|taking|grab|claim|have|get|need|ask for|request|borrow|steal|swap|switch|trade)\b/;
const NEAR = /\b(?:next to|near|beside|by|across from|close to|with|alongside|above|below|under|over)\s+$/;

/** The names a room answers to: its display name, minus a leading "the", and the plain id forms ("bedroom a", "bedroom 1"). */
export function bedroomNames(room: Room, display: string): string[] {
  const d = display.toLowerCase().replace(/^the\s+/, "").trim();
  const letter = /-([a-z])$/.exec(room)?.[1];
  const idx = letter ? letter.charCodeAt(0) - 96 : 0;
  const ord = ["", "first", "second", "third", "fourth"][idx] ?? "";
  return [...new Set([d, room.replace(/-/g, " "), ...(idx ? [`bedroom ${idx}`, `room ${letter}`] : []), ...(ord ? [`${ord} bedroom`] : [])])].filter(Boolean);
}

/** Lowercase with accents dropped ("Séance" => "seance"), so a themed room name matches however the player types it. */
const fold = (s: string): string => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
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
  const unquoted = stripNonActs(text);
  const clauses = unquoted.match(/[^.!;\n]+[.!;\n?]*/g) ?? [];
  let out: PlayerBedIntent | null = null;
  for (const raw of clauses) {
    const c = ` ${fold(raw).replace(/[’]/g, "'").replace(/[^a-z0-9' -]+/g, " ").replace(/\bbed ?room\b/g, "bedroom").replace(/\s+/g, " ").trim()} `;
    if (out?.kind === "claim" && /^ (?:actually|no|i mean|wait)\b/.test(c) && !BED_WORD.test(c)) { // "I take a bed in bedroom A. Actually bedroom B.": the correction replaces the room
      const fixed = rooms.find((r) => r.names.some((n) => findName(c, fold(n)) >= 0));
      if (fixed) { out = { kind: "claim", room: fixed.room, ...(out.prefer ? { prefer: out.prefer } : {}) }; continue; }
    }
    const subjectOther = people.some((p) => p.names.some((n) => new RegExp(`^${esc(fold(n))} (?:took|takes|taking|claimed|claims|grabbed|grabs|picked|picks|has|got|gets|snagged)\\b`).test(c.trim())));
    if (!BED_WORD.test(c) || HEDGE.test(c) || subjectOther) continue;
    if (/\b(?:tell|told|telling)\s+\S+(?:\s+\S+)?\s+(?:to|she|he|they|that)\b/.test(c) && !SWAP_VERB.test(c)) continue;
    const named = people.map((p) => ({ id: p.id, at: Math.max(...p.names.map((n) => findName(c, fold(n)))), names: p.names })).filter((p) => p.at >= 0);
    // ORW-1179: a swap is the PLAYER's own ask. It needs a first-person want/take of that houseguest's bed, a first-person (or imperative, or directly addressed) swap verb, and a question only counts when it
    // is the ask itself ("can I swap beds with X?"). A remark, a look, a seat, someone else's swap, or "is that X's bed?" never moves the player: the houseguest says yes from how they feel, so a stray
    // read here moved the player without them asking.
    const isQuestion = /\?\s*$/.test(raw.trim());
    const askShape = /^ (?:can|could|may|might|would|will) (?:i|we|you)\b/.test(c);
    const possessed = named.find((p) => p.names.some((n) => new RegExp(`\\b${esc(fold(n))}'s\\s+(?:bed|bunk|spot)\\b`).test(c)));
    if (possessed) {
      if (FIRST_PERSON.test(c) && POSSESSED_ASK.test(c) && (!isQuestion || askShape)) out = { kind: "swap", who: possessed.id };
      continue;
    }
    if (SWAP_VERB.test(c) && named.length > 0) {
      const addressed = named.find((p) => p.at <= 1); // "Dana, want to trade beds?": the player speaks to the houseguest
      const imperative = /^ (?:swap|switch|trade|exchange)\b/.test(c);
      if (!/\b(?:tell|told|telling)\b/.test(c) && (FIRST_PERSON.test(c) || imperative || addressed) && (!isQuestion || askShape || addressed)) out = { kind: "swap", who: (addressed ?? named[0]!).id };
      continue;
    }
    if (/\?\s*$/.test(raw.trim()) && !/^\s*(?:can|could|may) i (?:take|have|grab|claim)\b/.test(c.trim())) continue; // "is that bed free?" asks, "can I take it?" claims
    if (!CLAIM_VERB.test(c)) continue;
    const room = rooms.find((r) => r.names.some((n) => findName(c, fold(n)) >= 0));
    const prefer = /\b(?:double|queen|king)\b/.test(c) ? "double" as const : /\bsingle\b/.test(c) ? "single" as const : undefined;
    // ORW-1082: "bedroom A, no wait, C": the correction inside the same breath wins
    const fix = /\b(?:no wait|no actually|i mean)\s+(?:bedroom\s+)?(.+)$/.exec(c.trim())?.[1];
    const fixed = fix === undefined ? undefined : rooms.find((r) => r.names.some((n) => findName(` ${fix} `, fold(n)) >= 0)) ?? rooms.find((r) => /^[abc]\b/.test(fix) && r.room === `bedroom-${fix[0]}`);
    if (fixed) { out = { kind: "claim", room: fixed.room, ...(prefer ? { prefer } : {}) }; continue; }
    if (room) { out = { kind: "claim", room: room.room, ...(prefer ? { prefer } : {}) }; continue; }
    const near = named.find((p) => NEAR.test(c.slice(0, p.at)));
    if (near) out = { kind: "near", who: near.id };
  }
  return out;
}
