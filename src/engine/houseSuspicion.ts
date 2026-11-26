/**
 * The house WHISPERS about closed-door pairings — the 0077 NPC-side increment (the conspicuousness
 * read, but for the HOUSE, not just the player). When two NPCs are conspicuously holed up together in a
 * private room, a plausibly-positioned third houseguest notices and a Vault-free POSITION suspicion
 * (who slipped off where — NEVER what they said) rises and diffuses NPC-to-NPC along the affinity graph,
 * exactly like a scene rumor (0038). A chain that terminates at the player lands a player belief: the
 * house tells the player about pairings they didn't witness themselves.
 *
 * CALIBRATION (sacred): this is TEXTURE, never the spine. The caller hands a DEDICATED rng (never the
 * shared society/competition/vote stream), and the diffusion runs WITHOUT a relationship fold (no
 * `rel`/`subjects` to `diffuseGossip`) — so it moves no edge and consumes no shared draw. The seeded
 * `juryReach` + gradient outcomes are byte-identical with this on or off (proven by the heavy sims).
 * Vault Wall: only the observable FACT of a meeting crosses, through a modeled pathway — never the
 * sealed scene; paranoia stays the player's to form (0017).
 */
import { isPrivateRoom, roomDisplayName, type Occupancy, type Room } from "../domain/house";
import type { EntityId } from "../domain/ids";
import type { KnowledgeService } from "../ports/KnowledgeService";
import type { RandomnessSource } from "../ports/RandomnessSource";
import { makeSocialGraph, diffuseGossip, GOSSIP } from "./gossip";
import { PRIVACY } from "./presenceConstants";
import { DIARY_STAY_FACT_PREFIX } from "./heldFacts";

export interface HouseSuspicionDeps {
  /** The WEIGHTED, player-facing occupancy (what the house observably looks like) — never the base. */
  occupancy: Occupancy;
  /** Consecutive ticks each houseguest has held their current room (presence tenure). */
  tenureOf: (id: EntityId) => number;
  /** Active + AWAKE NPCs (evicted/asleep excluded by the caller — they neither linger nor whisper). */
  npcs: readonly EntityId[];
  player: EntityId;
  /** Directed affinity read (0017/0026) — who is motivated to notice/care about whom. */
  affinity: (a: EntityId, b: EntityId) => number;
  nameOf: (id: EntityId) => string;
  /** ORW-466: the room as it reads mid-sentence this season ("the Coral Reef Room"); absent: "the " + the plain label. */
  roomRef?: (room: Room) => string;
  knowledge: KnowledgeService;
  /** A DEDICATED rng stream — MUST NOT be the shared society/vote stream (calibration neutrality). */
  rng: RandomnessSource;
  /** 0148: the player is napping - they are not a node of the rumor graph this tick (nothing reaches a sleeper). Absent => unchanged. */
  playerAsleep?: boolean;
  /** ORW-614 (P-9): the player is a houseguest like any other for the house's eye: shut in a private room with one houseguest, they ARE the pair; and with two houseguests the room holds three. Played games only (absent: the player is not counted, byte-identical). The player never hears their own pairing back. */
  countPlayer?: boolean;
}

/** What the house whispered this tick (for tests/telemetry) — never surfaced raw to anyone. */
export interface WhisperedPairing {
  pair: readonly [EntityId, EntityId];
  room: Room;
  origin: EntityId;
}

/**
 * Find a conspicuous NPC pairing and, occasionally, diffuse a Vault-free suspicion about it. Returns the
 * pairing whispered (≤1 per call), or `[]` when nothing rose (no pairing, the gate stayed shut, or no
 * onlooker was positioned to notice). Pure aside from the knowledge writes + the dedicated rng.
 */
export function whisperConspicuousPairings(deps: HouseSuspicionDeps): WhisperedPairing[] {
  const { occupancy, tenureOf, npcs, player, affinity, nameOf, knowledge, rng } = deps;
  const npcSet = new Set(npcs);

  // 1. Conspicuous NPC pairings: a PRIVATE room holding EXACTLY two awake NPCs, both lingering a while.
  const byRoom = new Map<Room, EntityId[]>();
  for (const [id, room] of occupancy) {
    if (!isPrivateRoom(room)) continue;
    if (id === player ? !(deps.countPlayer && !deps.playerAsleep) : !npcSet.has(id)) continue;
    const list = byRoom.get(room) ?? [];
    list.push(id);
    byRoom.set(room, list);
  }
  const pairings: Array<{ pair: [EntityId, EntityId]; room: Room }> = [];
  for (const [room, who] of byRoom) {
    if (who.length !== PRIVACY.conspicuousPairSize) continue;
    if (who.some((id) => tenureOf(id) < PRIVACY.conspicuousMinTenureTicks)) continue;
    pairings.push({ pair: [who[0]!, who[1]!], room });
  }
  if (pairings.length === 0) return [];

  // The house only OCCASIONALLY whispers (a rumor rises sometimes), and about ONE pairing per tick.
  if (rng.next() >= PRIVACY.whisperProb) return [];
  const chosen = pairings[rng.int(pairings.length)]!;

  // 2. The ORIGIN onlooker: an awake NPC NOT in the pair, OUT in the observable house (a non-private
  //    room — they could plausibly have clocked the pair slipping off), most motivated to notice
  //    (highest affinity toward either of the pair). No one around ⇒ no metaphysical read; nothing rises.
  const inPair = new Set<EntityId>(chosen.pair);
  const onlookers = npcs.filter((id) => !inPair.has(id) && !isPrivateRoom(occupancy.get(id) ?? "diary-room"));
  if (onlookers.length === 0) return [];
  const pull = (id: EntityId): number => Math.max(affinity(id, chosen.pair[0]), affinity(id, chosen.pair[1]));
  const origin = onlookers.reduce((best, id) => (pull(id) > pull(best) ? id : best));

  // 3. Diffuse the Vault-free POSITION suspicion (names + room + "keep slipping off" - never the scene's
  //    content) NPC-to-NPC along the affinity graph. NO `rel`/`subjects` => NO fold (texture only); the
  //    dedicated rng => zero shared-stream draws. A chain reaching the player lands a player belief.
  const playerInPair = chosen.pair.includes(player);
  if (!spreadSuspicion(playerInPair ? { ...deps, playerAsleep: true } : deps, origin, `word in the house: ${nameOf(chosen.pair[0])} and ${nameOf(chosen.pair[1])} keep slipping off to ${deps.roomRef ? deps.roomRef(chosen.room) : `the ${roomDisplayName(chosen.room)}`} together`)) return [];
  return [{ pair: chosen.pair, room: chosen.room, origin }];
}

/**
 * Diffuse one Vault-free position fact NPC-to-NPC along the affinity graph from `origin` (no relationship fold: texture only, a dedicated rng).
 * False when no edge exists to carry it. Shared by the closed-door whisper above and the public-habit whisper below.
 */
function spreadSuspicion(deps: HouseSuspicionDeps, origin: EntityId, content: string, factId?: string): boolean {
  const { npcs, player, affinity, knowledge, rng } = deps;
  const everyone = deps.playerAsleep ? [...npcs] : [player, ...npcs];
  const edges: Array<readonly [EntityId, EntityId]> = [];
  for (let i = 0; i < everyone.length; i++) {
    for (let j = i + 1; j < everyone.length; j++) {
      if (affinity(everyone[i]!, everyone[j]!) > GOSSIP.affinityEdge) edges.push([everyone[i]!, everyone[j]!] as const);
    }
  }
  if (edges.length === 0) return false;
  diffuseGossip({
    knowledge,
    graph: makeSocialGraph(edges),
    rng,
    origin,
    fact: { content },
    ...(factId !== undefined ? { factId } : {}), // ORW-694: an explicit lineage (the Diary Room stay whisper's, held inert by heldCandidates); absent = minted as before
    rounds: GOSSIP.rounds,
    transmitProb: GOSSIP.transmitProb,
    decay: GOSSIP.decay,
    // Deliberately NO rel/subjects/sceneType: a position whisper moves no relationship edge (the player FORMS the read; 0017).
  });
  return true;
}

/** ORW-566 / spec 0183 (part b): a private pair habit kept at a PUBLIC spot was SEEN by the houseguests who stood in that room (`seenBy`). */
export interface HabitSighting { pair: readonly [EntityId, EntityId]; room: Room; onlookers: readonly EntityId[] }

/**
 * A witnessed habit starts a whisper: the onlooker most motivated to notice (highest affinity toward either of the pair) tells the house the PAIR keeps
 * ending up at that spot after the ceremonies - position only, never what was said. Occasional (the same gate as the closed-door whisper), on the
 * caller's DEDICATED rng, no relationship fold. Returns the pairing whispered or undefined.
 */
export function whisperHabitSighting(deps: HouseSuspicionDeps, s: HabitSighting): WhisperedPairing | undefined {
  const npcSet = new Set(deps.npcs);
  const onlookers = s.onlookers.filter((id) => npcSet.has(id) && !s.pair.includes(id));
  if (onlookers.length === 0) return undefined;
  if (deps.rng.next() >= PRIVACY.whisperProb) return undefined;
  const pull = (id: EntityId): number => Math.max(deps.affinity(id, s.pair[0]), deps.affinity(id, s.pair[1]));
  const origin = onlookers.reduce((best, id) => (pull(id) > pull(best) ? id : best));
  const where = deps.roomRef ? deps.roomRef(s.room) : `the ${roomDisplayName(s.room)}`;
  if (!spreadSuspicion(deps, origin, `word in the house: ${deps.nameOf(s.pair[0])} and ${deps.nameOf(s.pair[1])} keep ending up in ${where} together after the ceremonies`)) return undefined;
  return { pair: [s.pair[0], s.pair[1]], room: s.room, origin };
}

/** ORW-694 / B1-11 (spec 0210 C2, "both ways"): a LONG Diary Room stay the house saw - an NPC back after a long call, or the player's own stay into a second in-game hour. */
export interface DiaryStaySighting { who: EntityId; onlookers: readonly EntityId[]; /** a stable key for the stay (who + the in-game hour), the whisper's lineage */ key?: string }

/**
 * A long Diary Room stay starts a whisper: the onlooker most drawn to the one who was in there tells the house they were in the Diary Room a long while - a POSITION fact, never what
 * was said (nothing said in there is read, passed on or stored). Occasional (the same gate as every house whisper), on the caller's DEDICATED rng, no relationship fold (texture,
 * calibration-neutral). The player's own stay spreads among the houseguests only: the player is never told about themselves. Returns the whisper or undefined.
 */
export function whisperLongDiaryStay(deps: HouseSuspicionDeps, s: DiaryStaySighting): { who: EntityId; origin: EntityId } | undefined {
  const npcSet = new Set(deps.npcs);
  const onlookers = s.onlookers.filter((id) => npcSet.has(id) && id !== s.who);
  if (onlookers.length === 0) return undefined;
  if (deps.rng.next() >= PRIVACY.whisperProb) return undefined;
  const origin = onlookers.reduce((best, id) => (deps.affinity(id, s.who) > deps.affinity(best, s.who) ? id : best));
  const own = s.who === deps.player;
  const lineage = `${DIARY_STAY_FACT_PREFIX}${s.key ?? `${s.who}:${deps.rng.int(1_000_000)}`}`; // ORW-694 (c): held copies are inert (heldFacts.isInertWhisper)
  if (!spreadSuspicion(own ? { ...deps, playerAsleep: true } : deps, origin, `word in the house: ${deps.nameOf(s.who)} was in the Diary Room a long while`, lineage)) return undefined;
  return { who: s.who, origin };
}
