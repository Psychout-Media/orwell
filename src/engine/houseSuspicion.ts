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
    if (id === player || !npcSet.has(id) || !isPrivateRoom(room)) continue;
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

  // 3. Diffuse the Vault-free POSITION suspicion (names + room + "keep slipping off" — never the scene's
  //    content) NPC-to-NPC along the affinity graph. NO `rel`/`subjects` ⇒ NO fold (texture only); the
  //    dedicated rng ⇒ zero shared-stream draws. A chain reaching the player lands a player belief.
  const everyone = deps.playerAsleep ? [...npcs] : [player, ...npcs];
  const edges: Array<readonly [EntityId, EntityId]> = [];
  for (let i = 0; i < everyone.length; i++) {
    for (let j = i + 1; j < everyone.length; j++) {
      if (affinity(everyone[i]!, everyone[j]!) > GOSSIP.affinityEdge) edges.push([everyone[i]!, everyone[j]!] as const);
    }
  }
  if (edges.length === 0) return [];
  diffuseGossip({
    knowledge,
    graph: makeSocialGraph(edges),
    rng,
    origin,
    fact: { content: `word in the house: ${nameOf(chosen.pair[0])} and ${nameOf(chosen.pair[1])} keep slipping off to ${deps.roomRef ? deps.roomRef(chosen.room) : `the ${roomDisplayName(chosen.room)}`} together` },
    rounds: GOSSIP.rounds,
    transmitProb: GOSSIP.transmitProb,
    decay: GOSSIP.decay,
    // Deliberately NO rel/subjects/sceneType — a position whisper moves no relationship edge (the
    // player FORMS the read; 0017). This is exactly what keeps the calibration spine byte-identical.
  });
  return [{ pair: chosen.pair, room: chosen.room, origin }];
}
