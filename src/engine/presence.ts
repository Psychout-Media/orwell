/**
 * Presence assignment + overhearing (feature 0049). Seeded, relationship-weighted occupancy —
 * facts the narrator queries, not a simulation the player operates. Allies drift together,
 * the HOH gravitates upstairs, schemers find space — all through the seeded RandomnessSource
 * (same seed, same trajectories), with movement constrained to the floor plan.
 */
import { HOUSE_ROOMS, HOUSE_ADJACENCY, areAdjacent, isZonedRoom, pickZone, zonesAdjacentEarshot, zonesFor, type Room, type Zone, type Occupancy } from "../domain/house";
import { PLAYER } from "../domain/ids";
import type { EntityId } from "../domain/ids";
import type { RandomnessSource } from "../ports/RandomnessSource";
import type { KnowledgeService } from "../ports/KnowledgeService";
import { PRESENCE, MOVEMENT_PERSONALITY, MOVEMENT_INTENT } from "./presenceConstants";

/** A tiny deterministic string hash (FNV-1a) — pure, draws no rng. Used only to seat zones reproducibly. */
function zoneHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * Deterministically seat an entity into a sub-zone of their (zoned) room (0077 Phase 2) — PURE, draws
 * NO rng, and STABLE for a given (id, room, salt), so the same houseguest reads the same corner of the
 * yard all game (flavor continuity) and the seating can never perturb the seeded calibration spine.
 * Returns `undefined` for an un-zoned room. The salt is a per-game constant (the game seed).
 */
export function zoneFor(id: EntityId, room: Room, salt: string | number = ""): Zone | undefined {
  if (!isZonedRoom(room)) return undefined;
  return pickZone(room, zoneHash(`${salt}:${id}:${room}`));
}

/**
 * SEATED sub-zone assignment (issue #792 — the PO ruling: move sub-zones from on-read `zoneFor` to a
 * persisted, per-id SEAT written by `assignRooms`, enabling organic DRIFT and affinity CLUSTERING).
 *
 * For each id placed in a ZONED room, seat a zone into `out`:
 *   • FRESH seat — they were NOT in this zoned room last tick (just arrived, or no prior zone): seed the
 *     INITIAL seat from `zoneFor` (the on-read helper becomes the seeding fallback — stable per (id,room,
 *     salt)), then optionally cluster toward already-seated zone-mates the mover has affinity to.
 *   • HELD seat — they kept the same zoned room and already have a zone: most ticks they STAY in their
 *     corner; with chance `zoneDriftProb` they DRIFT to a re-rolled (cluster-weighted) zone.
 * Un-zoned rooms seat nothing (no entry in `out`). Every draw rides the caller-supplied `rng` — which the
 * adapter routes to the DEDICATED movement stream (never the shared society/competition/vote spine), so
 * seated zones stay calibration-neutral exactly like the L21/L24 weighted occupancy.
 *
 * `salt` is the per-game seed (continuity of the fresh seat across a restart). `affinity`/`clusterPull`
 * are optional (absent ⇒ no clustering — bare seeded seat/drift). `prevZones` is last tick's seating.
 */
export function seatZones(
  occupancy: ReadonlyMap<EntityId, Room>,
  prevZones: ReadonlyMap<EntityId, Zone> | null | undefined,
  out: Map<EntityId, Zone>,
  deps: { rng: RandomnessSource; salt?: string | number; affinity?: (a: EntityId, b: EntityId) => number; clusterPull?: number },
): void {
  const salt = deps.salt ?? "";
  const clusterPull = deps.clusterPull ?? 0;
  for (const [id, room] of occupancy) {
    if (!isZonedRoom(room)) continue; // un-zoned room ⇒ no seat (the lone-space default)
    const zones = zonesFor(room);
    const heldZone = prevZones?.get(id);
    // A HELD seat = the houseguest carries a prior zone that is VALID FOR THE CURRENT ROOM. Zone
    // vocabularies don't overlap between rooms (backyard: poolside/patio/workout; lounge: couches/
    // window-nook), so a prior zone valid here means they kept this zoned room — no prior-room read needed.
    const held = heldZone !== undefined && zones.includes(heldZone);
    if (held) {
      // Hold the corner most ticks; occasionally amble to another (cluster-weighted) zone. ONE drift draw.
      if (deps.rng.next() >= PRESENCE.zoneDriftProb) { out.set(id, heldZone); continue; }
    }
    // Fresh seat OR a drift: the INITIAL candidate is the on-read deterministic zone (the seeding
    // fallback), then affinity-cluster toward already-seated zone-mates in this same room. ONE seat draw
    // when clustering is active (a weighted pick); otherwise the deterministic seed needs no draw.
    const seed = zoneFor(id, room, salt) ?? zones[0]!;
    if (clusterPull <= 0 || !deps.affinity) { out.set(id, held ? pickDriftZone(zones, heldZone!) : seed); continue; }
    // Weight each zone by affinity to those already seated there this pass (zone-scoped clustering).
    const weights = zones.map((z) => {
      let w = z === seed ? 1.5 : 1; // a mild home-corner prior so the deterministic seed still anchors
      for (const [other, oz] of out) {
        if (other === id) continue;
        if (occupancy.get(other) === room && oz === z) w += clusterPull * Math.max(0, deps.affinity!(id, other));
      }
      return w;
    });
    const total = weights.reduce((a, b) => a + b, 0);
    let roll = deps.rng.next() * total;
    let chosen = zones[zones.length - 1]!;
    for (let i = 0; i < zones.length; i++) { roll -= weights[i]!; if (roll <= 0) { chosen = zones[i]!; break; } }
    out.set(id, chosen);
  }
}

/** Pick a drift destination zone DIFFERENT from the current one (corner-to-corner); falls back to current if alone. */
function pickDriftZone(zones: readonly Zone[], current: Zone): Zone {
  const others = zones.filter((z) => z !== current);
  return others.length ? others[0]! : current;
}

/**
 * A houseguest's movement personality (L21/L24) — WHO they are, read off the static CHARACTER +
 * dynamic SOUL: `social` is their social aptitude (`stats.social`, ~0–1), `volatility` their current
 * emotional turbulence (`soul.volatility`, ~0–1; `0.5` is settled). The caller supplies these so the
 * pure presence module never reaches into the engine's character/soul state directly. ABSENT ⇒ the
 * base (pre-L21/L24) behavior — every term defaults to its no-op center, so old call sites are
 * byte-for-byte unchanged.
 */
export interface MovementProfile {
  /** Social aptitude (static `stats.social`, ~0–1). High ⇒ roams + seeks company; low ⇒ holds a room. */
  social: number;
  /** Current emotional turbulence (dynamic `soul.volatility`, ~0–1; `0.5` settled). High ⇒ restless. */
  volatility: number;
}

/**
 * A houseguest's MOTIVATED draw toward another (feature 0078) — read off the relationship model by the
 * caller, so the pure presence module never reaches into the engine's relationship state directly.
 *  • `weight` ≥ 0 — how much this houseguest's motivation points at the OTHER right now: high for a
 *    strong ally to seek out, a deal/bloc partner to honor, OR a rival/target to corner and WORK (any
 *    CHARGED tie is a reason to go find them). `0` ⇒ no agenda toward them (the neutral default).
 *  • `avoid` — `true` when the motivation is to keep DISTANCE (a dangerous threat with no bond to work),
 *    so their room is softly de-weighted instead of sought. A pull can be either drawn-toward or
 *    avoided, never both; a houseguest the NPC has no charged read on yields no entry at all.
 * The caller returns one entry per OTHER the NPC has an agenda about; absent ⇒ no intent ⇒ the base
 * 0049/0076 behavior, byte-identical.
 */
export interface MovementPull {
  /** The houseguest this NPC's motivation is about. */
  target: EntityId;
  /** Strength of the agenda toward `target` (≥ 0). Larger ⇒ a stronger reason to be where they are. */
  weight: number;
  /** `true` ⇒ keep DISTANCE (de-weight their room) rather than seek it. Default `false` ⇒ drawn toward. */
  avoid?: boolean;
}

/** A houseguest's full motivation this tick (feature 0078): the set of others they have an agenda about. */
export type MovementIntent = readonly MovementPull[];

export interface PresenceDeps {
  rng: RandomnessSource;
  /** Directed affinity read (0017/0026) — how much `a` wants to be around `b`. */
  affinity: (a: EntityId, b: EntityId) => number;
  hoh?: EntityId | null;
  /**
   * Per-NPC movement personality (L21/L24). Optional: when absent (or returns null for an id), that
   * houseguest moves on the base 0049 behavior — so this is a pure additive nudge, no behavior change
   * for callers that don't supply it. The profile DRAWS NO rng of its own; it only re-weights the
   * move-gate threshold and the affinity pull. The L21/L24 isolation comes from the CALLER routing this
   * `rng` to a dedicated movement stream (`presenceTick`) — separate from the shared competition/vote
   * stream — and from the off-screen society pairing on a calibration-neutral, un-weighted base occupancy.
   */
  movement?: (id: EntityId) => MovementProfile | null;
  /**
   * Per-NPC MOTIVATED movement (feature 0078) — who this houseguest's agenda wants them near right now
   * (an ally to bond with, a rival/target to work, a deal/bloc partner to honor) and who they want
   * distance from (a pure threat). When present, the destination weighting pulls toward (or pushes off)
   * the rooms those targets occupy, so co-presence is EARNED by intent rather than arbitrary drift.
   *
   * Optional and back-compatible: absent (or `null`/`[]` for an id) ⇒ NO intent ⇒ the base 0049/0076
   * behavior, byte-identical. Unlike `movement` (L21/L24, calibration-NEUTRAL on a dedicated stream),
   * intent is DELIBERATELY calibration-load-bearing (owner ruling 0078: location must affect play) and
   * is supplied on BOTH the base and weighted passes. It DRAWS NO rng of its own — it only re-weights
   * the per-candidate destination weights and the move-gate threshold (one stay-gate draw + at most one
   * destination draw, exactly as before) — so the per-NPC shared-stream draw COUNT is unchanged; the
   * spine moves only by WHICH room intent steers toward, which the 0078 calibration pass re-tunes for.
   * The pull magnitudes/cap live in `MOVEMENT_INTENT` (the sibling-constants pattern). Vault-free.
   */
  intent?: (id: EntityId) => MovementIntent | null;
  /**
   * The player's CURRENT room (feature 0076) — the live scene. When set (the player-facing WEIGHTED
   * pass only), an NPC who is already in this room uses `sceneMoveProb` for the stay-gate instead of
   * their ordinary move rate, so present company holds a live conversation instead of churning out
   * every tick. Absent (the calibration-neutral BASE pass) ⇒ no scene stickiness, behavior unchanged.
   */
  sceneRoom?: Room | null;
  /**
   * The (low) per-tick MOVE probability for an NPC standing in `sceneRoom` (feature 0076). Applies
   * ONLY when `sceneRoom` is set and the NPC is in it. Consumes the SAME single stay-gate `rng.next()`
   * draw as the ordinary path (only the THRESHOLD differs), so the per-NPC draw count is unchanged.
   */
  sceneMoveProb?: number;
  /**
   * ORW-212 / ORW-210 - CALM, non-magnetic movement (WEIGHTED pass only; absent => the pre-ORW-212 behaviour, byte-identical). `moveScale` scales an ordinary NPC's move chance; `maxMovers` caps how
   * many NPCs relocate in this one tick; `startOffset` rotates who the cap blocks; `holdIds` restricts the 0076 scene-hold to the houseguests the player is actually talking to; `playerId` + `excludePlayerPull`
   * keep the player out of the affinity sum that picks a destination.
   */
  calm?: { moveScale: number; maxMovers: number; startOffset: number; holdIds: ReadonlySet<EntityId>; playerId: EntityId; excludePlayerPull: boolean };
  /**
   * SEATED sub-zone output (issue #792 — opt-in). When supplied, `assignRooms` also SEATS each placed
   * houseguest's sub-zone into this map (for zoned rooms only), enabling persisted DRIFT + affinity
   * CLUSTERING via `seatZones`. ABSENT (every base-pass / legacy caller) ⇒ no zone seating, no extra
   * `rng` draw — byte-identical. The CALLER must route `rng` to the DEDICATED movement stream and pass
   * `zonesOut` ONLY on the player-facing weighted pass, so seated zones stay calibration-neutral (never
   * the shared society/competition/vote spine — the L21/L24 isolation discipline).
   */
  zonesOut?: Map<EntityId, Zone>;
  /** Last tick's seated zones (issue #792) — held seats stay put / drift; absent ⇒ everyone seats fresh. */
  previousZones?: ReadonlyMap<EntityId, Zone> | null;
  /** The per-game salt (the game seed) for the deterministic fresh-seat fallback (issue #792). */
  zoneSalt?: string | number;
}

/** The signed social deviation from center, used by both the move-rate and seek-pull nudges. */
function socialDeviation(p: MovementProfile | null | undefined): number {
  return p ? p.social - MOVEMENT_PERSONALITY.socialCenter : 0;
}

/**
 * A houseguest's personality-adjusted MOVE probability for this tick (L21/L24). High social aptitude
 * and a churning (high-volatility) soul both raise it; low social aptitude lowers it. Clamped into a
 * hard [floor, ceiling] so nobody ever fully freezes or always-teleports. With no profile this returns
 * the base `PRESENCE.moveProb` exactly (no behavior change). Reads personality data, draws NO rng.
 */
function moveProbFor(p: MovementProfile | null | undefined): number {
  if (!p) return PRESENCE.moveProb;
  const M = MOVEMENT_PERSONALITY;
  const fromSocial = socialDeviation(p) * M.moveAptitudeWeight;
  const fromVolatility = (p.volatility - 0.5) * M.volatilityWeight;
  const adjusted = PRESENCE.moveProb + fromSocial + fromVolatility;
  return Math.max(M.moveProbFloor, Math.min(M.moveProbCeil, adjusted));
}

/**
 * A houseguest's personality-adjusted AFFINITY PULL toward occupied rooms (L21/L24): high-social
 * houseguests seek company more strongly, low-social ones less. Floored at 0 (never repulsion). With
 * no profile this returns the base `PRESENCE.affinityPull` exactly. Reads personality data, draws NO rng.
 */
function seekPullFor(p: MovementProfile | null | undefined): number {
  if (!p) return PRESENCE.affinityPull;
  const M = MOVEMENT_PERSONALITY;
  return Math.max(M.seekPullFloor, PRESENCE.affinityPull + socialDeviation(p) * M.seekAptitudeWeight);
}

/**
 * The NET motivated pull a houseguest feels toward a single ROOM this tick (feature 0078): sum the
 * agenda toward every target currently in that room (reading the occupancy being built, exactly as the
 * affinity cluster does), `avoid` subtracting. Positive ⇒ drawn toward; negative ⇒ wants distance; `0`
 * ⇒ no agenda there. Draws NO rng — a pure read of the supplied motivation. `null`/`[]` intent ⇒ `0`.
 */
function roomIntentScore(intent: MovementIntent | null | undefined, room: Room, placed: ReadonlyMap<EntityId, Room>): number {
  if (!intent || intent.length === 0) return 0;
  let s = 0;
  for (const pull of intent) {
    if (placed.get(pull.target) !== room) continue; // the target isn't here ⇒ this room earns no pull
    const w = Math.max(0, pull.weight);
    s += pull.avoid ? -w : w;
  }
  return s;
}

/**
 * The STRONGEST unsatisfied pursuit a houseguest has this tick (feature 0078): the largest drawn-toward
 * (non-`avoid`) agenda whose target is NOT already in the houseguest's current room — a reason to get up
 * and go looking. Returns `0` when every pursuit is satisfied (target already here), there is no
 * drawn-toward agenda at all, or on first placement (no `here`). Draws NO rng. Feeds the move-gate nudge.
 */
function unsatisfiedPursuit(intent: MovementIntent | null | undefined, here: Room | undefined, placed: ReadonlyMap<EntityId, Room>): number {
  if (!intent || intent.length === 0 || here === undefined) return 0;
  let best = 0;
  for (const pull of intent) {
    if (pull.avoid) continue; // avoidance is a destination de-weight, not a reason to chase
    if (placed.get(pull.target) === here) continue; // already with them ⇒ no unmet pursuit toward them
    best = Math.max(best, Math.max(0, pull.weight));
  }
  return best;
}

/**
 * The intentional move-gate probability (feature 0078): an unsatisfied pursuit raises the base move
 * rate so the houseguest goes looking for their target, scaled by `moveIntentStrength × pursuitMoveBias`
 * and clamped into the SAME [moveProbFloor, moveProbCeil] the personality rate uses (nobody teleports
 * every tick). `pursuit === 0` ⇒ returns `base` unchanged ⇒ byte-identical. NEVER applied to a held
 * scene-room companion (0076 stickiness wins — that gate is chosen by the caller before this is called).
 */
function intentMoveProb(base: number, pursuit: number): number {
  if (pursuit <= 0) return base;
  const M = MOVEMENT_PERSONALITY;
  const I = MOVEMENT_INTENT;
  const raised = base + Math.min(1, pursuit) * I.pursuitMoveBias * I.moveIntentStrength;
  return Math.max(M.moveProbFloor, Math.min(M.moveProbCeil, raised));
}

/**
 * Assign every ACTIVE houseguest exactly one room. With a previous occupancy, each houseguest
 * either stays put or moves to an ADJACENT room (no teleporting — ADR 0003 §8); the very first
 * assignment may place anyone anywhere. Deterministic for a given rng stream: iteration order
 * is the caller's `active` array (stable), choices come only from `rng`.
 */
export function assignRooms(
  active: readonly EntityId[],
  previous: Occupancy | null,
  deps: PresenceDeps,
  // PINNED houseguests are seated FIRST and never moved — the engine drives only `active`, but the
  // pinned still pull the movers (affinity clustering reads them). Used to hold the PLAYER in place
  // (a person, not engine-relocated — L21/L24) while NPCs may still gravitate to the player's room.
  pinned?: Occupancy | null,
): Map<EntityId, Room> {
  const next = new Map<EntityId, Room>(pinned ?? undefined);
  const calm = deps.calm;
  let movers = 0;
  let moveOrigin: Room | null = null; // ORW-212: all of a calm tick's departures leave the SAME room (a group disbanding); moves from different rooms never line up
  const order: readonly EntityId[] = calm && active.length > 0 ? [...active.slice(calm.startOffset % active.length), ...active.slice(0, calm.startOffset % active.length)] : active;
  for (const id of order) {
    const here = previous?.get(id);
    // L21/L24: who this houseguest IS bends HOW they move — read once per houseguest (no rng draw),
    // so the per-NPC `rng` draw count is identical with or without a profile (the isolation guarantee).
    const profile = deps.movement?.(id) ?? null;
    // 0078: WHERE their motivation points — read once per houseguest (no rng draw), same isolation
    // guarantee. Absent ⇒ null ⇒ every intent term below is a no-op (byte-identical to pre-0078).
    const intent = deps.intent?.(id) ?? null;
    // Candidate rooms: anywhere on first assignment; stay-or-adjacent afterwards. The diary
    // room is never a hangout (it is a booth, not a lounge).
    const candidates: readonly Room[] = (here
      ? [here, ...(HOUSE_ADJACENCY.get(here) ?? [])]
      : HOUSE_ROOMS
    ).filter((r) => r !== "diary-room");
    // The stay-vs-move gate, bent by personality (L21/L24): a high-social/restless houseguest roams
    // more, a low-social/settled one holds their room. ONE `rng.next()` draw, exactly as before — the
    // personality only moves the THRESHOLD it is compared against (no extra draw). This `rng` is the
    // DEDICATED movement stream (`presenceTick`), never the shared competition/vote stream, so however
    // the threshold shifts which branch is taken it cannot perturb calibration (the L21/L24 isolation).
    //
    // 0076: present company holds the scene. When this NPC is in the PLAYER'S room (`sceneRoom`, set only
    // on the weighted pass), the gate uses the low `sceneMoveProb` instead of their ordinary rate — they
    // stay by default but keep full agency to leave (the low roll still fires, and the affinity-weighted
    // destination below reads as a motivated exit). Still ONE draw, so the per-NPC draw count is unchanged.
    //
    // 0078: OTHERWISE, an UNSATISFIED pursuit (a motive target not in this room) raises the move rate —
    // they get up and go looking. Still ONE draw (only the threshold shifts); the scene-hold case wins
    // (a companion mid-scene with the player isn't yanked away by an off-screen agenda).
    const heldByScene = here !== undefined && here === deps.sceneRoom && deps.sceneMoveProb !== undefined && (!calm || calm.holdIds.has(id));
    const moveThreshold = heldByScene
      ? deps.sceneMoveProb!
      : intentMoveProb(moveProbFor(profile), unsatisfiedPursuit(intent, here, next)) * (calm ? calm.moveScale : 1);
    if (here && deps.rng.next() >= moveThreshold) {
      next.set(id, here); // most ticks, most people stay where they are
      continue;
    }
    // ORW-212: gradual re-seat - once the tick's mover budget is spent, everyone else who would have moved stays put this tick (the gate draw is already consumed).
    if (calm && here && (movers >= calm.maxMovers || (moveOrigin !== null && here !== moveOrigin))) { next.set(id, here); continue; }
    // Weight each candidate by who is already there (affinity pull, bent by how much THIS houseguest
    // seeks company — L21/L24) + the HOH-room pull + the MOTIVATED pull toward/away (0078).
    const seekPull = seekPullFor(profile);
    const weights = candidates.map((room) => {
      let w = 1;
      for (const [other, theirRoom] of next) {
        if (calm?.excludePlayerPull && other === calm.playerId) continue; // ORW-210: NPCs do not gravitate to the player's room just because the player is in it
        if (theirRoom === room) w += seekPull * deps.affinity(id, other);
      }
      if (room === "hoh-room") w = id === deps.hoh ? w + PRESENCE.hohRoomPull * 4 : w * PRESENCE.hohRoomPull;
      // 0078: intent STEERS the roll — a room holding a target the NPC's agenda points at gains weight
      // (seek them out); a room holding a threat they avoid loses weight. Bounded by `maxRoomBonus` (as a
      // multiple of the room's pre-intent weight) so a clear motive strongly favors a room without ever
      // zeroing the seeded variance the calibration spine rests on (steer, never force). `w` stays ≥ 0.
      const score = roomIntentScore(intent, room, next);
      if (score !== 0) {
        const bonus = w * MOVEMENT_INTENT.maxRoomBonus * Math.tanh(score * MOVEMENT_INTENT.moveIntentStrength);
        w = Math.max(0, w + bonus);
      }
      return w;
    });
    const total = weights.reduce((a, b) => a + b, 0);
    let roll = deps.rng.next() * total;
    let chosen = candidates[candidates.length - 1]!;
    for (let i = 0; i < candidates.length; i++) {
      roll -= weights[i]!;
      if (roll <= 0) { chosen = candidates[i]!; break; }
    }
    if (here && chosen !== here) { movers++; if (calm && moveOrigin === null) moveOrigin = here; }
    next.set(id, chosen);
  }
  if (calm) { // restore the stable (caller) insertion order the rotation scrambled - pinned first, then `active` order
    const ordered = new Map<EntityId, Room>(pinned ?? undefined);
    for (const id of active) { const r = next.get(id); if (r !== undefined) ordered.set(id, r); }
    next.clear(); for (const [k, v] of ordered) next.set(k, v);
  }
  // SEAT sub-zones (issue #792, OPT-IN). Only when the caller supplies `zonesOut` — i.e. the player-
  // facing weighted pass on the DEDICATED movement stream — so the base/calibration pass draws nothing
  // here and the seeded spine is byte-identical. Drift/cluster ride the SAME `deps.rng` as the placement.
  if (deps.zonesOut) {
    seatZones(next, deps.previousZones, deps.zonesOut, {
      rng: deps.rng,
      salt: deps.zoneSalt,
      affinity: deps.affinity,
      clusterPull: PRESENCE.zoneClusterPull,
    });
  }
  return next;
}

/**
 * Roll the adjacency overhear for one resolved scene (BOTH directions by construction — the
 * listeners are simply whoever occupies an adjacent room, player or NPC). ONE gate per scene,
 * ONE ear when it opens (the player has priority — the flagship beat is player-centric): an
 * overhear is a RARE, special beat, not a chorus, and every one is a recorded propagation
 * event the persistence layer pays for. A success surfaces a PARTIAL, lower-confidence belief
 * through the real 0002 pathway (`overheard:<eventId>`), so every overhear is traceable —
 * eavesdropping is information-gathering, never narrative vibes. Returns who overheard.
 */
export function rollOverhears(deps: {
  eventId: string;
  room: Room;
  content: string;
  participants: readonly EntityId[];
  occupancy: Occupancy;
  knowledge: KnowledgeService;
  rng: RandomnessSource;
  /**
   * Closed-door MUFFLE (0077 Phase 2, OPT-IN): a multiplier on the per-scene gate probability — a
   * scene behind a closed door is harder to hear into. ABSENT ⇒ `1` ⇒ the gate threshold and thus
   * the entire draw branch are BYTE-IDENTICAL to the pre-0077 build. The off-screen society/spine
   * passes nothing here (calibration stays sacred); only the player channel — on its own isolated
   * `commands:` rng stream — opts in.
   */
  muffle?: number;
  /**
   * The scene's own SUB-ZONE within a big room (0077 / PO ruling #791, OPT-IN). When supplied along
   * with `zoneOf`, a SAME-ROOM bystander in an ADJACENT, distinct zone (the patio next to the pool) is
   * an overhear-eligible listener too — they catch the same rare, partial, lower-confidence fragment an
   * adjacent ROOM does, rather than becoming a full witness. Same-zone occupants are already in the
   * scene's witness set (passed as `participants`) and are excluded; FAR zones never hear. ABSENT (or
   * `zoneOf` unwired) ⇒ no zoned listeners ⇒ the listener set + every draw are BYTE-IDENTICAL to the
   * pre-ruling adjacent-room-only path. The off-screen society/spine passes neither (calibration sacred).
   */
  sceneZone?: Zone;
  zoneOf?: (id: EntityId) => Zone | undefined;
}): EntityId[] {
  const listeners: EntityId[] = [];
  for (const [id, where] of deps.occupancy) {
    if (deps.participants.includes(id)) continue; // you can't overhear your own scene
    if (areAdjacent(where, deps.room)) { listeners.push(id); continue; } // walls work; next door listens
    // 0077 (PO ruling #791): a SAME-ROOM ADJACENT-zone bystander overhears a fragment (not a witness).
    // Only when zone info is supplied (player channel); FAR/same zones are excluded (same ⇒ witness).
    if (where === deps.room && deps.zoneOf && zonesAdjacentEarshot(deps.room, deps.sceneZone, deps.zoneOf(id))) {
      listeners.push(id);
    }
  }
  if (listeners.length === 0) return [];
  // ONE gate draw, exactly as before — only the THRESHOLD shifts when a caller opts into the muffle
  // (a closed-door scene is quieter). `muffle ?? 1` ⇒ no caller ⇒ the original `overhearProb`.
  if (deps.rng.next() >= PRESENCE.overhearProb * (deps.muffle ?? 1)) return []; // gated per scene, never guaranteed
  const who = listeners.includes(PLAYER) ? PLAYER : listeners[deps.rng.int(listeners.length)]!;
  // Partial by DESIGN and by construction: the overhearer catches a strict fragment (never the
  // whole line), so a hidden scene's full content can never reach anyone verbatim through a wall —
  // the orchestrator's vault-leak checkpoint (a full-content substring sweep) stays strict and green.
  const caught = deps.content.slice(0, Math.max(1, Math.floor(deps.content.length * PRESENCE.overhearFraction)));
  deps.knowledge.surfaceInformationTo(
    who,
    { content: `(overheard, muffled) ${caught}…`, confidence: PRESENCE.overhearConfidence },
    `overheard:${deps.eventId}`,
  );
  return [who];
}
