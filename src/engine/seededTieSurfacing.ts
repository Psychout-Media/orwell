/**
 * Feature 0059 §5 — the organic SURFACING scheduler for hidden pre-game TIES (the DEFERRED follow-on).
 *
 * A seeded pre-game tie (two houseguests who knew each other before the show) exists at cast time but is
 * Vault-sealed from the player AND the admin. It surfaces to the house ONLY organically, exactly as
 * 0058's dormant story threads and 0077's closed-door whispers do: as the live edge between the pair
 * genuinely warms over weeks, a careful observer eventually NOTICES they are unusually close — that they
 * seem to already know each other — and a Vault-free belief diffuses NPC-to-NPC along the affinity graph
 * (0038). A chain that terminates at the player lands a player belief: the house tells the player about a
 * tie they didn't seed and couldn't see. NEVER a banner, never exposition, never the sealed `nature`.
 *
 * Knowledge vs. suspicion holds (0002): what the player comes to hold is a soft BELIEF formed from
 * observed behavior ("those two seem unusually tight, like they go way back"), a read they build their
 * own paranoia/trust around (0017) — they may suspect a pre-show connection long before (or without ever)
 * coming to know it. The sealed reason the two know each other never crosses; only that the house has
 * started to read them as close.
 *
 * CALIBRATION (sacred — mandate #4): this is TEXTURE, never the spine, and it is gated by a flag (default ON; `=0` turns it off).
 *   • The caller (`GameSessionAdapter.advanceSeededTies`) runs this ONLY behind the
 *     `ORWELL_SEEDED_TIE_SURFACING` flag (default ON; `=0` turns it off), so the seeded juryReach / gradient / UAT sims that run with it off never enter this code at all — the off-screen tick is byte-identical to the pre-feature
 *     build (no extra draw, no extra event, no fold).
 *   • Even when ON, every roll here is on the caller's DEDICATED rng (off the game seed + a tick
 *     counter), never the shared society/competition/vote stream.
 *   • The NPC↔NPC diffusion runs WITHOUT a relationship fold (no `rel`/`subjects` to `diffuseGossip`) —
 *     pure position/warmth gossip that moves no edge. The §5 consequence fold (a discovered tie shifts
 *     third-party reads) is the caller's separate, flag-gated step — it never lives in the calibration
 *     baseline.
 */
import { isPrivateRoom, type Occupancy } from "../domain/house";
import type { EntityId } from "../domain/ids";
import type { KnowledgeService } from "../ports/KnowledgeService";
import type { RandomnessSource } from "../ports/RandomnessSource";
import { makeSocialGraph, diffuseGossip, GOSSIP } from "./gossip";
import { SEEDED_TIE_SURFACING } from "./seededRelationshipConstants";
import type { PreGameTie } from "./seededRelationships";

export interface TieSurfacingDeps {
  /** The sealed pre-game ties (engine-only). Showmances are handled by `advanceShowmances`, not here. */
  ties: readonly PreGameTie[];
  /** Active + awake NPCs (evicted/asleep excluded by the caller — they neither notice nor are noticed). */
  npcs: readonly EntityId[];
  player: EntityId;
  /** ORW-1086: the player has left the house (evicted, season over): they are no node of the house's talk and nothing reaches them as house news. Absent = in the house. */
  playerOut?: boolean;
  /** Directed affinity read (0017/0026) — how warm the live edge between two houseguests is. */
  affinity: (a: EntityId, b: EntityId) => number;
  nameOf: (id: EntityId) => string;
  knowledge: KnowledgeService;
  /** The live player-facing occupancy (optional) — used only to pick a plausibly-positioned observer. */
  occupancy?: Occupancy;
  /**
   * Player-surface seam (§5.2, rare): land the Vault-free tie observation in the PLAYER's knowledge
   * through an anchored `told-by` pathway, returning whether the player actually came to hold it. The
   * caller owns the knowledge/event handles (the registry wires it like the 0060 thread seam) and counts
   * a success against the season cap. Returns false ⇒ the surfacing stayed NPC-side this tick.
   */
  surfaceToPlayer: (subject: EntityId, observation: string) => boolean;
  /**
   * §5 consequence fold — a discovered tie shifts THIRD-PARTY reads (an onlooker re-reads the pair now
   * that they see the two are close). Reuses the existing 0023 fold; the caller owns the relationship
   * model + a dedicated fold rng. Engine-only (moves a hidden edge; the player sees only later behavior).
   * Invoked ONLY when a tie is freshly discovered this tick, and ONLY behind the opt-in flag.
   */
  foldDiscovery: (observer: EntityId, pair: readonly [EntityId, EntityId]) => void;
  /** Has this tie's subject already surfaced TO THE PLAYER before (the season cap is keyed on it)? */
  alreadySurfacedToPlayer: (subject: EntityId) => boolean;
  /** How many ties have surfaced TO THE PLAYER so far this season (vs. the hard cap). */
  playerSurfaceCount: number;
  /** A DEDICATED rng — MUST NOT be the shared society/vote stream (calibration neutrality). */
  rng: RandomnessSource;
}

/** What surfaced this tick (for tests/telemetry) — never the sealed `nature`; only the observable read. */
export interface SurfacedTie {
  pair: readonly [EntityId, EntityId];
  observer: EntityId;
  /** True iff the observation reached the PLAYER's knowledge this tick (vs. staying NPC↔NPC gossip). */
  reachedPlayer: boolean;
}

/**
 * Surface ONE observable seeded tie this tick (≤1 per call — surfacing trickles, never bursts), or `[]`
 * when nothing rose (no observable tie, the gate stayed shut, or no observer was positioned). Pure aside
 * from the knowledge writes via the caller's seams + the dedicated rng. Vault-free by construction: the
 * only thing that ever crosses is the observable read "these two seem unusually close", never WHY.
 */
export function surfaceSeededTies(deps: TieSurfacingDeps): SurfacedTie[] {
  const {
    ties, npcs, player, playerOut, affinity, nameOf, knowledge, occupancy,
    surfaceToPlayer, foldDiscovery, alreadySurfacedToPlayer, playerSurfaceCount, rng,
  } = deps;
  const C = SEEDED_TIE_SURFACING;
  const alive = new Set(npcs);

  // 1. OBSERVABLE ties: a seeded pre-game tie whose pair are BOTH still in (and awake), and whose live
  //    mutual affinity has warmed past the floor — the two have genuinely grown close in the house, so an
  //    onlooker could plausibly read it. A tie that hasn't warmed into the open stays fully Vault-sealed.
  const observable = ties.filter((t) => {
    if (t.visibility === "public") return false; // ORW-132: a tie public from Day 1 is already a house fact - nothing to discover
    if (!alive.has(t.a) || !alive.has(t.b)) return false;
    const mutual = Math.min(affinity(t.a, t.b), affinity(t.b, t.a));
    return mutual >= C.observableAffinity;
  });
  if (observable.length === 0) return [];

  // The house only OCCASIONALLY notices, and about ONE tie per tick.
  if (rng.next() >= C.noticeProb) return [];
  const tie = observable[rng.int(observable.length)]!;
  const pair: readonly [EntityId, EntityId] = [tie.a, tie.b];

  // 2. The OBSERVER: an awake NPC NOT in the pair, OUT in the observable house (not behind a closed door),
  //    most motivated to notice (warmest toward either of the pair). No one positioned ⇒ nothing rises.
  const inPair = new Set<EntityId>(pair);
  const candidates = npcs.filter(
    (id) => !inPair.has(id) && !isPrivateRoom(occupancy?.get(id) ?? "kitchen"),
  );
  if (candidates.length === 0) return [];
  const pull = (id: EntityId): number => Math.max(affinity(id, tie.a), affinity(id, tie.b));
  const observer = candidates.reduce((best, id) => (pull(id) > pull(best) ? id : best));

  // The Vault-free observation — names + "seem unusually close / like they go way back". NEVER the sealed
  // reason (casting-callback / mutual-friend / shared-hometown). It reads as behavior, not a confirmed fact.
  const observation = `word in the house: ${nameOf(tie.a)} and ${nameOf(tie.b)} seem unusually tight — like they might go back further than the rest of us`;

  // 3a. Diffuse the observation NPC↔NPC along the affinity graph (0038). NO `rel`/`subjects` ⇒ NO fold
  //     (texture only); the dedicated rng ⇒ zero shared-stream draws. The origin holds it even on a cold
  //     graph (diffuseGossip seeds the origin first), so the noticing never silently vanishes.
  const everyone = playerOut ? [...npcs] : [player, ...npcs];
  const edges: Array<readonly [EntityId, EntityId]> = [];
  for (let i = 0; i < everyone.length; i++) {
    for (let j = i + 1; j < everyone.length; j++) {
      if (affinity(everyone[i]!, everyone[j]!) > GOSSIP.affinityEdge) edges.push([everyone[i]!, everyone[j]!] as const);
    }
  }
  diffuseGossip({
    knowledge,
    graph: makeSocialGraph(edges),
    rng,
    origin: observer,
    fact: { content: observation },
    rounds: GOSSIP.rounds,
    transmitProb: GOSSIP.transmitProb,
    decay: GOSSIP.decay,
    // Deliberately NO rel/subjects/sceneType — the gossip moves no edge (the calibration-neutral half).
  });

  // 3b. RARELY, and under the season cap, the observation reaches the PLAYER through an anchored pathway
  //     (§5.2). Most noticing stays NPC-side; the player catches a tie only sometimes. Already-surfaced
  //     ties don't re-spend the cap.
  let reachedPlayer = false;
  const capRoom = playerSurfaceCount < C.maxPlayerSurfacesPerSeason;
  if (!playerOut && capRoom && !alreadySurfacedToPlayer(tie.a) && rng.next() < C.surfaceToPlayerProb) {
    reachedPlayer = surfaceToPlayer(tie.a, observation);
  }

  // 4. §5 consequence fold — a FRESHLY discovered tie shifts the OBSERVER's read of the pair (they
  //    re-evaluate the two now that they see how close they are). Reuses the 0023 fold (caller-owned,
  //    flag-gated). The fold runs on the discovery regardless of whether it reached the player — the
  //    house's read moved either way; only the player's KNOWLEDGE is gated by the pathway/cap above.
  foldDiscovery(observer, pair);

  return [{ pair, observer, reachedPlayer }];
}
