/**
 * The house itself (feature 0049): canonical rooms + a static adjacency map, in the pure
 * domain core. Adjacency is DATA, not behavior — the same house every season (it doesn't
 * remodel), so presence facts ("who's here, who's one room over") have stable ground truth.
 * No I/O, no randomness: occupancy ASSIGNMENT lives in the engine (`src/engine/presence.ts`);
 * this module only knows the floor plan and the invariants.
 */
import type { EntityId } from "./ids";

export type Room =
  | "kitchen" | "living-room" | "dining-room" | "backyard"
  | "hallway"
  | "bedroom-a" | "bedroom-b" | "bedroom-c" | "bathroom" | "lounge"
  | "hoh-room" | "storage-room" | "diary-room"
  | "landing";

export const HOUSE_ROOMS: readonly Room[] = [
  "kitchen", "living-room", "dining-room", "backyard",
  "hallway",
  "bedroom-a", "bedroom-b", "bedroom-c", "bathroom", "lounge",
  "hoh-room", "storage-room", "diary-room",
  "landing",
];

/**
 * The floor plan (ORW-711, owner ruling 2026-11-19; the house is a general U shape). An OPEN PUBLIC CORE off the front door:
 * the `living-room` is the front-door hub (kitchen, dining room, hallway, bathroom, lounge, the stairs to the landing and the diary
 * room all open off it); the kitchen and the dining room both open onto the `backyard`, which is off to the side (NOT off the living
 * room). The three bedrooms sit on the ground floor off the `hallway`. The bathroom and the one small lounge are off the living room
 * (and off each other); there is no have-not room. Upstairs there is only the HOH room, reached through a small `landing` (the stairs
 * come up from the living room): the landing is semi-public, where people wait to see the HOH and play games. The HOH room is closed
 * and private and opens onto the landing alone; the storage room is the quick-meeting spot off the kitchen; the diary room opens off
 * the living room and adjoins nothing else (PRIVATE, so overhearing it is impossible by data). Symmetric by construction (asserted by
 * the unit tests).
 */
export const HOUSE_ADJACENCY: ReadonlyMap<Room, readonly Room[]> = new Map<Room, readonly Room[]>([
  ["kitchen", ["living-room", "dining-room", "backyard", "storage-room"]],
  ["living-room", ["kitchen", "dining-room", "hallway", "bathroom", "lounge", "landing", "diary-room"]],
  ["dining-room", ["kitchen", "living-room", "backyard"]],
  ["backyard", ["kitchen", "dining-room"]],
  ["hallway", ["living-room", "bedroom-a", "bedroom-b", "bedroom-c"]],
  ["bedroom-a", ["hallway"]],
  ["bedroom-b", ["hallway"]],
  ["bedroom-c", ["hallway"]],
  ["bathroom", ["living-room", "lounge"]],
  ["lounge", ["living-room", "bathroom"]],
  ["landing", ["living-room", "hoh-room"]],
  ["hoh-room", ["landing"]],
  ["storage-room", ["kitchen"]],
  ["diary-room", ["living-room"]],
]);

export function areAdjacent(a: Room, b: Room): boolean {
  return a !== b && (HOUSE_ADJACENCY.get(a) ?? []).includes(b);
}

/**
 * ORW-711 (player parity): the rooms strictly BETWEEN `from` and `to` on the shortest walk through the adjacency graph (deterministic breadth-first, neighbours tried in the table's own order; no rng).
 * Empty for an adjacent pair, the same room, or an unreachable one. Pure.
 */
export function roomsBetween(from: Room, to: Room): Room[] {
  if (from === to) return [];
  const prev = new Map<Room, Room>();
  const seen = new Set<Room>([from]);
  const queue: Room[] = [from];
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i]!;
    if (cur === to) break;
    for (const n of HOUSE_ADJACENCY.get(cur) ?? []) {
      if (seen.has(n)) continue;
      seen.add(n);
      prev.set(n, cur);
      queue.push(n);
    }
  }
  if (!seen.has(to)) return [];
  const path: Room[] = [];
  for (let c = prev.get(to); c !== undefined && c !== from; c = prev.get(c)) path.unshift(c);
  return path;
}

/**
 * The SIGHTLINE graph (0077 Phase 2 — eyeshot, NARROWER than adjacency where it matters). Adjacency
 * is who you can WALK to; sightline is whose occupants you can SEE from where you stand. The OPEN-PLAN
 * PUBLIC CORE (kitchen / living-room / dining-room / backyard) is one mutual-visibility CLIQUE —
 * open plan + glass to the yard, so standing in any one you see everyone in all four (this is the one
 * place sightline reaches PAST a direct door: you can see across the great room to the yard without a
 * dining→backyard doorway). The living room also sees into the `hallway` mouth (who is loitering /
 * moving through it). EVERY OTHER room is a CLOSED door — opaque from outside: standing next to a
 * bedroom, the bathroom, the lounge, the HOH room (up its own stairs), the storage room (the quiet
 * meeting spot), or the sealed diary room reveals NOTHING about who is inside — crucially, from the
 * hallway you do NOT see into the bedrooms it adjoins. That opacity is the privacy payoff (owner note
 * #3): who is behind a closed door is KNOWLEDGE you earn by watching a doorway, never a free read.
 * ORW-711: the `landing` is the one semi-public upstairs room: the stairs are open to the living room, so the two see each other, and
 * the HOH room's door opens onto the landing, so anyone standing there watches who goes in and out of it (see `canWitnessDeparture`).
 * Symmetric + irreflexive (asserted by the unit tests).
 */
export const HOUSE_SIGHTLINE: ReadonlyMap<Room, readonly Room[]> = new Map<Room, readonly Room[]>([
  ["kitchen", ["living-room", "dining-room", "backyard"]],
  ["living-room", ["kitchen", "dining-room", "backyard", "hallway", "landing"]],
  ["dining-room", ["kitchen", "living-room", "backyard"]],
  ["backyard", ["kitchen", "living-room", "dining-room"]],
  ["hallway", ["living-room"]],
  ["bedroom-a", []],
  ["bedroom-b", []],
  ["bedroom-c", []],
  ["bathroom", []],
  ["lounge", []],
  ["landing", ["living-room"]],
  ["hoh-room", []],
  ["storage-room", []],
  ["diary-room", []],
]);

/** Whether an observer standing in room `a` can SEE the occupants of room `b` (0077 Phase 2 eyeshot). */
export function areVisible(a: Room, b: Room): boolean {
  return a !== b && (HOUSE_SIGHTLINE.get(a) ?? []).includes(b);
}

/**
 * The doorway-watch rule (0077, ORW-711): an observer standing in `observer` WITNESSES someone leaving `origin` when it is their own room
 * or in their eyeshot. Standing on the landing, you therefore see who goes in and out of the HOH room (the door is on the landing). Pure.
 */
export function canWitnessDeparture(observer: Room, origin: Room): boolean {
  return origin === observer || areVisible(observer, origin);
}

/**
 * A PRIVATE room is one NO other room has sightline INTO — a closed door, opaque from outside (0077
 * Phase 2). Its occupants are never an ambient proximity read; they are learned only by watching a
 * doorway (the tracked-occupancy layer). Derived from the sightline graph (data, not a separate flag)
 * so the two can never drift. The public core + the hallway are public; everything else is private.
 */
export function isPrivateRoom(room: Room): boolean {
  for (const sees of HOUSE_SIGHTLINE.values()) if (sees.includes(room)) return false;
  return true;
}

/**
 * A named SUB-ZONE within a big room (0077 Phase 2 — owner note #2: "the backyard is big enough for
 * multiple groups to chat outside of earshot"). A zone is a presentation/earshot subdivision, NOT a
 * separate room: EYESHOT stays room-wide (everyone in the backyard SEES everyone, including that
 * another group is huddled across the yard — a conspicuousness signal in itself), but EARSHOT is
 * zone-scoped (a scene by the pool is not overheard at the workout corner). Plain strings, scoped to
 * the floor plan below.
 */
export type Zone = string;

/**
 * The one genuinely BIG room carries zones (ORW-711: the lounge is one small room now, so it has none); every other room is a single space (no entry here ⇒ no
 * zoning — `zonesFor` returns `[]`, and earshot/eyeshot behave exactly as the pre-zone build). The
 * backyard runs poolside → patio → workout (a line). Owner
 * note #2 + "resist zoning small rooms" (open question #4). Order is the canonical zone order.
 */
export const ROOM_ZONES: ReadonlyMap<Room, readonly Zone[]> = new Map<Room, readonly Zone[]>([
  ["backyard", ["poolside", "patio", "workout"]],
]);

/**
 * Which zones of a room are close enough to carry a small RESIDUAL overhear (adjacent zones), vs. far
 * enough to be fully out of earshot. The backyard is a LINE — poolside↔patio↔workout — so the two
 * ends (poolside/workout) are out of earshot of each other (the BDD "pool vs. workout corner" case);
 * (ORW-711: the lounge is one small room, so it has no zones.) A
 * room with no entry has no intra-room adjacency (every zone pair is "far", trivially — there is one
 * zone). Symmetric by construction (asserted by the unit tests).
 */
const ZONE_ADJACENCY: ReadonlyMap<Room, ReadonlyMap<Zone, readonly Zone[]>> = new Map([
  ["backyard", new Map<Zone, readonly Zone[]>([
    ["poolside", ["patio"]],
    ["patio", ["poolside", "workout"]],
    ["workout", ["patio"]],
  ])],
]);

/** Whether a room is subdivided into earshot zones (0077 — only the big rooms). */
export function isZonedRoom(room: Room): boolean {
  return ROOM_ZONES.has(room);
}

/** The canonical, ordered zones of a room — `[]` for an un-zoned room (every other room). */
export function zonesFor(room: Room): readonly Zone[] {
  return ROOM_ZONES.get(room) ?? [];
}

/**
 * Whether two zones of the SAME room share FULL earshot — i.e. are the SAME zone (PO ruling, issue
 * #791). The same zone always is; an un-zoned room has at most one zone, so any two co-present
 * occupants there are trivially same-zone (`a === b`), preserving the pre-zone "same room ⇒ in
 * earshot" behavior; `undefined` zones (no zone info supplied) are treated as the same single space —
 * back-compatible. This is the WITNESS predicate: only a SAME-zone bystander is auto-added as a full
 * co-witness. An ADJACENT zone is NOT a full witness — it is overhear-eligible only (`zonesAdjacentEarshot`).
 */
export function zonesSameEarshot(room: Room, a: Zone | undefined, b: Zone | undefined): boolean {
  if (a === undefined || b === undefined || a === b) return true;
  // An UN-zoned room is one single space — any two occupants there are full earshot (pre-zone behavior).
  if (!isZonedRoom(room)) return true;
  // Distinct, defined zones in a ZONED room are never the SAME zone (regardless of adjacency).
  return false;
}

/**
 * Whether two zones of the SAME room are ADJACENT but DISTINCT (0077 / PO ruling #791): close enough
 * for a RARE, PARTIAL, lower-confidence OVERHEAR — the same fragment treatment an adjacent ROOM gets —
 * but NOT full earshot (that is `zonesSameEarshot`). False for the same zone (that is full earshot, not
 * an overhear), for un-zoned/undefined zones (one space — no intra-room overhear path), and for FAR
 * zones (the two ends of the backyard line — out of earshot entirely). The
 * backyard line poolside↔patio↔workout makes patio adjacent to both ends. Symmetric by construction (asserted by the tests).
 */
export function zonesAdjacentEarshot(room: Room, a: Zone | undefined, b: Zone | undefined): boolean {
  if (a === undefined || b === undefined || a === b) return false;
  if (!isZonedRoom(room)) return false;
  return (ZONE_ADJACENCY.get(room)?.get(a) ?? []).includes(b);
}

/**
 * Whether two zones of the SAME room are within earshot of each other AT ALL (0077): same zone OR
 * adjacent zone. The UNION of `zonesSameEarshot` + `zonesAdjacentEarshot`, retained for callers that
 * only need "can these two hear each other in any form". Far zones (the two ends of the backyard) are not.
 */
export function zonesInEarshot(room: Room, a: Zone | undefined, b: Zone | undefined): boolean {
  return zonesSameEarshot(room, a, b) || zonesAdjacentEarshot(room, a, b);
}

/**
 * Deterministically seat an entity into one of a room's zones from an already-computed numeric KEY
 * (the caller hashes a stable identity — e.g. id+room — so the choice is reproducible and draws NO
 * rng; zones are a read-side projection, never a new shared-stream draw — the L21/L24 isolation).
 * Returns `undefined` for an un-zoned room (nothing to seat into).
 */
export function pickZone(room: Room, key: number): Zone | undefined {
  const zones = zonesFor(room);
  if (zones.length === 0) return undefined;
  return zones[((key % zones.length) + zones.length) % zones.length];
}

/**
 * The PUBLIC, natural display name for a room (the same `kitchen`/`living room`/`bedroom A`
 * the player and narrator say aloud). Pure presentation of a public room id — never a Vault
 * fact. Drives the model-facing room list so the narrator always knows the exact names it can
 * walk the player to, and grounds the "did you mean…" disambiguation.
 */
export function roomDisplayName(room: Room): string {
  if (room === "hoh-room") return "HOH room";
  // bedroom-a → "bedroom A", living-room → "living room", etc.
  return room.replace(/-([a-z])$/i, (_m, c: string) => ` ${c.toUpperCase()}`).replace(/-/g, " ");
}

/**
 * The rooms the player can actually WALK to — every real room except the diary room (a booth the
 * player enters via the Diary Room beat, never a hangout to mill in; ADR 0003 §8). The canonical,
 * ordered list the narrator is handed so it never has to GUESS a room id. Public/Vault-free.
 */
export const WALKABLE_ROOMS: readonly Room[] = HOUSE_ROOMS.filter((r) => r !== "diary-room");

/**
 * Natural-name → room-id ALIASES (the forgiving `moveTo` map). Keys are normalized (see
 * `normalizeRoomName`): lowercase, spaces/underscores/hyphens collapsed to a single hyphen. These
 * cover the names a narrator or player naturally says — "living room"/"lounge", "backyard"/"yard",
 * "HOH"/"head of household", "bathroom"/"washroom", "pantry" (the storage room). The bare "bedroom"
 * is handled specially (it is AMBIGUOUS — two bedrooms) by `resolveRoom`, never here.
 */
const ROOM_ALIASES: ReadonlyMap<string, Room> = new Map<string, Room>([
  ["kitchen", "kitchen"],
  ["living-room", "living-room"],
  ["livingroom", "living-room"],
  ["living", "living-room"],
  ["common-room", "living-room"],
  ["common-area", "living-room"],
  ["great-room", "living-room"],
  ["dining-room", "dining-room"],
  ["dining", "dining-room"],
  ["dining-area", "dining-room"],
  ["dinner", "dining-room"],
  ["dinner-table", "dining-room"],
  ["dining-table", "dining-room"],
  ["backyard", "backyard"],
  ["yard", "backyard"],
  ["outside", "backyard"],
  ["garden", "backyard"],
  ["patio", "backyard"],
  ["pool", "backyard"],
  ["poolside", "backyard"],
  ["hallway", "hallway"],
  ["hall", "hallway"],
  ["corridor", "hallway"],
  ["bedroom-a", "bedroom-a"],
  ["bedroom-1", "bedroom-a"],
  ["first-bedroom", "bedroom-a"],
  ["bedroom-b", "bedroom-b"],
  ["bedroom-2", "bedroom-b"],
  ["second-bedroom", "bedroom-b"],
  ["bedroom-c", "bedroom-c"],
  ["bedroom-3", "bedroom-c"],
  ["third-bedroom", "bedroom-c"],
  ["lounge", "lounge"],
  ["games-room", "lounge"],
  ["game-room", "lounge"],
  ["landing", "landing"],
  ["upstairs", "landing"],
  ["stairs", "landing"],
  ["staircase", "landing"],
  ["stairwell", "landing"],
  ["top-of-the-stairs", "landing"],
  ["hoh-room", "hoh-room"],
  ["hoh", "hoh-room"],
  ["hoh-suite", "hoh-room"],
  ["hoh-bedroom", "hoh-room"],
  ["head-of-household", "hoh-room"],
  ["head-of-household-room", "hoh-room"],
  ["bathroom", "bathroom"],
  ["washroom", "bathroom"],
  ["restroom", "bathroom"],
  ["toilet", "bathroom"],
  ["shower", "bathroom"], // ORW-1180: "head to the shower" is a walk to the bathroom
  ["showers", "bathroom"],
  ["storage-room", "storage-room"],
  ["storage", "storage-room"],
  ["pantry", "storage-room"],
  ["diary-room", "diary-room"],
  ["diary", "diary-room"],
  ["dr", "diary-room"],
]);

/**
 * Normalize a free-text room name to the alias-key form: lowercase, trim, every run of
 * whitespace/underscore/hyphen collapsed to a single hyphen. So "Living Room", "living_room",
 * "LIVING-ROOM", and " living  room " all key to "living-room". Case/space/hyphen-insensitive.
 */
export function normalizeRoomName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** The shape of a room-name resolution (see `resolveRoom`). */
export type RoomResolution =
  /** Exactly one room matched — walk there. */
  | { kind: "ok"; room: Room }
  /** The name is a real room but AMBIGUOUS (e.g. bare "bedroom") — the candidates, best-guess first. */
  | { kind: "ambiguous"; candidates: readonly Room[] }
  /** No room matches at all. */
  | { kind: "unknown" };

/**
 * Resolve a FREE-TEXT room name (whatever the narrator/player typed) to a canonical room id —
 * forgiving by design so a guessed "bedroom" or "living room" never silently fails into a retry
 * loop (the real-log bug). Pure + deterministic + Vault-free (rooms are public):
 *   0. this season's themed names (`themed`, ORW-466), before the built-in aliases: accents and curly apostrophes never matter, and the
 *      same leading article/possessive is dropped from both sides ("the coral reef", "captain’s quarters", "seance room");
 *   1. exact room id / known alias (case/space/hyphen-insensitive);
 *   2. the bare word "bedroom" / "bed" / "room" → AMBIGUOUS across the two bedrooms, but
 *      DISAMBIGUATED to a single room when context allows: the player's CURRENT bedroom if they
 *      are already in one (stay), else a bedroom ADJACENT to where they stand, else bedroom-a;
 *   3. a loose substring/prefix match against the canonical names (e.g. "kit" → kitchen);
 *   4. otherwise unknown.
 * `currentRoom` (where the player stands) only sharpens the bedroom/loose disambiguation; omit it
 * and a bare "bedroom" simply reports both bedrooms as candidates.
 */
export function resolveRoom(name: string, currentRoom?: Room | null, themed?: ReadonlyArray<readonly [alias: string, room: Room]>): RoomResolution {
  // Strip a leading article/possessive the narrator may write ("the kitchen", "my bedroom") before
  // keying — a robustness nicety so "the Living Room" resolves like "living room".
  const LEAD = /^(the|a|an|my|our|your|to|into|go-to|head-to|over-to)-/;
  const key = normalizeRoomName(name).replace(LEAD, "");
  if (key === "") return { kind: "unknown" };
  // 0. ORW-466: this season's themed names first ("the coral reef", "captain's quarters"); accents and curly apostrophes never matter ("seance room", "captain’s quarters"),
  //    and the alias loses the same leading article the key lost.
  if (themed && themed.length) {
    const flat = (s: string): string => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[\u2018\u2019\u02BC]/g, "'");
    const k = flat(key);
    for (const [alias, room] of themed) if (flat(normalizeRoomName(alias).replace(LEAD, "")) === k) return { kind: "ok", room };
  }
  // 1. exact alias / room id.
  const alias = ROOM_ALIASES.get(key);
  if (alias) return { kind: "ok", room: alias };

  // 2. the ambiguous "bedroom" family — pick sensibly when we can, else report the candidates.
  const bedrooms: readonly Room[] = ["bedroom-a", "bedroom-b", "bedroom-c"];
  const isBedroomy = key === "bedroom" || key === "bedrooms" || key === "bed" || key === "room" || key === "beds";
  if (isBedroomy) {
    if (currentRoom && bedrooms.includes(currentRoom)) return { kind: "ok", room: currentRoom }; // already in one — stay
    const adjacentBedroom = currentRoom ? bedrooms.find((b) => areAdjacent(currentRoom, b)) : undefined;
    if (adjacentBedroom) return { kind: "ok", room: adjacentBedroom }; // step into the nearest bedroom
    return { kind: "ambiguous", candidates: bedrooms };
  }

  // 3. loose match against canonical names — flat-form prefix/substring AND token-by-token prefix, so
  //    "kit" → kitchen, "back yard" → backyard, "store room" → storage room (each typed token prefixes
  //    a room token in order). Forgiving without being reckless: a key token must PREFIX a room token.
  const flatKey = key.replace(/-/g, "");
  const keyTokens = key.split("-").filter(Boolean);
  const tokenPrefixMatch = (roomTokens: readonly string[]): boolean => {
    if (keyTokens.length > roomTokens.length) return false;
    return keyTokens.every((kt, i) => roomTokens[i]!.startsWith(kt) || kt.startsWith(roomTokens[i]!));
  };
  const matches = HOUSE_ROOMS.filter((r) => {
    const c = normalizeRoomName(r);
    const flatC = c.replace(/-/g, "");
    return (
      c.startsWith(key) || key.startsWith(c) ||
      flatC.startsWith(flatKey) || flatC.includes(flatKey) ||
      tokenPrefixMatch(c.split("-").filter(Boolean))
    );
  });
  const unique = [...new Set(matches)];
  if (unique.length === 1) return { kind: "ok", room: unique[0]! };
  if (unique.length > 1) {
    if (currentRoom) {
      const here = unique.includes(currentRoom) ? currentRoom : unique.find((r) => areAdjacent(currentRoom, r));
      if (here) return { kind: "ok", room: here };
    }
    return { kind: "ambiguous", candidates: unique };
  }
  return { kind: "unknown" };
}

export type Occupancy = ReadonlyMap<EntityId, Room>;

/**
 * The presence invariants (ADR 0003 §8 — people must make sense), as a checkable predicate:
 *  - every listed houseguest is in EXACTLY one room (Map shape guarantees ≤1; this checks =1);
 *  - movement from a previous assignment only crosses adjacency (or stays put).
 * Returns the violations so tests/checkpoints can name what broke.
 */
export function occupancyViolations(
  active: readonly EntityId[],
  occupancy: Occupancy,
  previous?: Occupancy,
): string[] {
  const problems: string[] = [];
  for (const id of active) {
    const room = occupancy.get(id);
    if (!room) { problems.push(`${id} occupies no room`); continue; }
    if (!HOUSE_ROOMS.includes(room)) problems.push(`${id} occupies unknown room ${room}`);
    const before = previous?.get(id);
    if (before && before !== room && !areAdjacent(before, room)) {
      problems.push(`${id} teleported ${before} → ${room}`);
    }
  }
  for (const id of occupancy.keys()) {
    if (!active.includes(id)) problems.push(`${id} occupies a room but is not active (evicted houseguests are nowhere)`);
  }
  return problems;
}
