/**
 * ORW-466 - the season's room names (Ryne 2026-11-15: "all rooms in the house to be themed"; "Themes should be random"). Pure: no I/O, no shared randomness.
 *
 * - `roomLabel`: what a room is called this season (its themed name), or today's plain label when the season has no theme.
 * - `themedRoomAliases`: the lowercase phrases a player (or the narrator) can use for a themed room, so "the Coral Reef" resolves like "bedroom A" does.
 * - `drawHouseTheme`: the season's theme, drawn from the seed (reproducible), never one of the player's recent seasons' themes.
 */
import { roomDisplayName, HOUSE_ROOMS, type Room } from "../domain/house";
import { HOUSE_THEMES, type HouseTheme } from "./data/houseThemes";
import { hashSeed } from "./characterFactory";

/**
 * ORW-509: season houses authored by the writer and ACCEPTED by `acceptHouseThemeDraft`. The id is content-addressed (a hash of the name and room names), so the
 * process-level map is safe on a multi-user engine: the same id always means the same house, a lookup can never return another user's different house, and it is
 * bounded (oldest evicted). The season itself carries the definition (`live.houseThemeDef`) and re-registers it on load, so eviction never loses a live house.
 */
const AUTHORED_THEMES = new Map<string, HouseTheme>();
const AUTHORED_THEMES_MAX = 64;

/** Register an accepted authored house so `houseTheme(id)`, `roomLabel` and `themedRoomAliases` resolve it like a library theme. Idempotent. */
export function registerHouseTheme(theme: HouseTheme): void {
  AUTHORED_THEMES.delete(theme.id);
  AUTHORED_THEMES.set(theme.id, theme);
  while (AUTHORED_THEMES.size > AUTHORED_THEMES_MAX) AUTHORED_THEMES.delete(AUTHORED_THEMES.keys().next().value as string);
}

/**
 * ORW-968 (Ryne, live playtest 2026-11-26: "Copper Kettle Galley ... maybe the kitchen, Ember Court, no clue"): a room's shown name says what the room IS. The plain word per room (the same words the player and the narrator
 * already say: kitchen, dining room, bedroom ...); the theme is a light modifier in front of it, never a name that stands in for it.
 */
const FUNCTION_WORD: Readonly<Record<Room, string>> = {
  "kitchen": "kitchen", "living-room": "living room", "dining-room": "dining room", "backyard": "backyard", "hallway": "hallway", "bedroom-a": "bedroom", "bedroom-b": "bedroom", "bedroom-c": "bedroom",
  "bathroom": "bathroom", "lounge": "lounge", "hoh-room": "HOH room", "landing": "landing", "storage-room": "storage room", "diary-room": "Diary Room",
} as Record<Room, string>;
/** A generic last word on a themed name that only repeats "this is a room" ("the Coral Reef Room"): dropped from the head before the plain word goes on. */
const HEAD_TAIL = /(^|\s+)(room|cabin|pod|cave|chamber|suite|quarters)$/i;
/** Per room, a last word that is the same role in other words ("the Bubblegum Bath" for the bathroom): dropped from the head so the plain word does not double it. */
const ROLE_TAIL: Partial<Record<Room, RegExp>> = { "bathroom": /(^|\s+)(bath|baths|washroom|restroom)$/i };
const hasWord = (text: string, word: string): boolean => new RegExp(`(^|[^a-z0-9])${word.toLowerCase().replace(/\s+/g, "\\s+")}s?($|[^a-z0-9])`, "i").test(text);  // "Kitchens" counts

/**
 * The themed `name` of `room`, said with the room's plain word: kept as written when it already contains the word ("the Fudge Kitchen", "the Lighthouse Diary Room"); otherwise the themed head and the plain word
 * ("the Galley" -> "the Galley kitchen", "the Coral Reef Room" -> "the Coral Reef bedroom"). Pure, composed from whatever name the season has (the library or the writer's own), no list of names.
 */
export function plainRoomName(room: Room, name: string): string {
  const word = FUNCTION_WORD[room];
  const raw = name.trim();
  if (!word || !raw) return raw;
  if (hasWord(raw, word)) return raw;
  let head = raw.replace(/^the\s+/i, "").trim();
  head = head.replace(HEAD_TAIL, "").trim();
  const role = ROLE_TAIL[room];
  if (role) head = head.replace(role, "").trim();
  return head ? `the ${head} ${word}` : `the ${word}`;
}

/** A library or authored theme with every room name said with its plain word (memoized by object: the lookup is hot). The look, the pitch and the id are untouched. */
const COMPOSED = new WeakMap<HouseTheme, HouseTheme>();
function withPlainNames(t: HouseTheme): HouseTheme {
  let c = COMPOSED.get(t);
  if (!c) {
    const rooms = Object.fromEntries((Object.entries(t.rooms) as Array<[Room, { name: string; look: string }]>).map(([r, v]) => [r, { ...v, name: plainRoomName(r, v.name) }])) as HouseTheme["rooms"];
    c = { ...t, rooms };
    COMPOSED.set(t, c);
  }
  return c;
}

/** The season's house by id with its room names plain (see `plainRoomName`); `rawHouseTheme` is the theme as written, for the writer's own freshness check. */
export function houseTheme(themeId: string | undefined): HouseTheme | undefined {
  const t = rawHouseTheme(themeId);
  return t ? withPlainNames(t) : undefined;
}
export function rawHouseTheme(themeId: string | undefined): HouseTheme | undefined {
  return themeId ? (HOUSE_THEMES.find((x) => x.id === themeId) ?? AUTHORED_THEMES.get(themeId)) : undefined;
}

/** Counts of why drafts were refused, by rule name (the acceptance report for the season line). */
export interface HouseThemeAcceptance { accepted: boolean; theme?: HouseTheme; rejected: Record<string, number>; fallback?: string }

const norm = (x: string): string => x.toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * ORW-509: wide generation, narrow acceptance, for the season house. The writer authors a whole house from the season's own facts (no menu); this reads it.
 * Rules, each counted when it fires: shape (an object with a name, a pitch and every one of the 13 rooms), length (room name 3-48 chars, look 20-280, pitch 20-300),
 * unique-in-house (no two rooms share a name, and no room is named like another), not-plain (a room is not just its plain label), fresh (no room name appears in the
 * library or in `avoidNames`, the last seasons' room names) - `freshShare` of the rooms (default 0.75) must pass it, so one reused "the Kitchen" does not sink a house.
 * Never throws. On refusal the caller keeps the engine floor: `drawHouseTheme(seed, recent)`, the library.
 */
export function acceptHouseThemeDraft(raw: unknown, opts: { avoidNames?: readonly string[]; avoidIds?: readonly string[]; freshShare?: number } = {}): HouseThemeAcceptance {
  const rejected: Record<string, number> = {};
  const no = (rule: string): HouseThemeAcceptance => { rejected[rule] = (rejected[rule] ?? 0) + 1; return { accepted: false, rejected, fallback: "library" }; };
  const d = raw as { name?: unknown; pitch?: unknown; rooms?: Record<string, { name?: unknown; look?: unknown } | undefined> } | null;
  if (!d || typeof d !== "object" || typeof d.name !== "string" || typeof d.pitch !== "string" || !d.rooms || typeof d.rooms !== "object") return no("shape");
  if (d.pitch.length < 20 || d.pitch.length > 300 || d.name.trim().length < 3 || d.name.length > 60) return no("length");
  const rooms = {} as Record<Room, { name: string; look: string }>;
  for (const r of HOUSE_ROOMS) {
    // ORW-711: a draft written before the landing existed has no landing; the library lends one (picked from the draft's own name, so it is reproducible) rather than refusing a whole house.
    const x = d.rooms[r] ?? (r === "landing" ? HOUSE_THEMES[hashSeed(String(d.name)) % HOUSE_THEMES.length]!.rooms.landing : undefined);
    if (!x || typeof x.name !== "string" || typeof x.look !== "string") return no("shape");
    const name = x.name.trim(); const look = x.look.trim();
    if (name.length < 3 || name.length > 48 || look.length < 20 || look.length > 280) return no("length");
    rooms[r] = { name, look };
  }
  const names = HOUSE_ROOMS.map((r) => norm(rooms[r].name));
  if (new Set(names).size !== names.length) return no("unique-in-house");
  if (HOUSE_ROOMS.some((r) => norm(rooms[r].name) === norm(roomDisplayName(r)))) return no("not-plain");
  const known = new Set<string>([...HOUSE_THEMES.flatMap((t) => HOUSE_ROOMS.map((r) => norm(t.rooms[r].name))), ...(opts.avoidNames ?? []).map(norm)]);
  const stale = names.filter((n) => known.has(n)).length;
  if (stale > Math.floor(HOUSE_ROOMS.length * (1 - (opts.freshShare ?? 0.75)))) return no("fresh");
  const id = `authored-${hashSeed(`${d.name}|${names.join("|")}`).toString(36)}`;
  if ((opts.avoidIds ?? []).includes(id) || HOUSE_THEMES.some((t) => t.id === id)) return no("fresh");
  const theme: HouseTheme = { id, name: d.name.trim(), pitch: d.pitch.trim(), rooms };
  return { accepted: true, theme, rejected };
}

/** This season's name for `room` ("the Coral Reef Room"), or the plain label when there is no (known) theme. */
export function roomLabel(room: Room, themeId?: string): string {
  return houseTheme(themeId)?.rooms[room]?.name ?? roomDisplayName(room);
}

/**
 * The room as it reads mid-sentence: the themed name exactly as written ("the Coral Reef Room", "Main Street"), or the plain label, with "the" in front when `article` (the default) - so a
 * caller never writes "the the Coral Reef Room".
 */
export function roomRef(room: Room, themeId?: string, article = true): string {
  const themed = houseTheme(themeId)?.rooms[room]?.name;
  return themed ?? `${article ? "the " : ""}${roomDisplayName(room)}`;
}

/** Every room's name this season (undefined without a theme), for a projection the narrator and the front end read. */
export function roomNamesFor(themeId?: string): Partial<Record<Room, string>> | undefined {
  const t = houseTheme(themeId);
  return t ? Object.fromEntries(Object.entries(t.rooms).map(([r, v]) => [r, v.name])) as Partial<Record<Room, string>> : undefined;
}

/** The one-line look of `room` this season, for the narrator; undefined without a theme. */
export function roomLook(room: Room, themeId?: string): string | undefined {
  return houseTheme(themeId)?.rooms[room]?.look;
}

/** Generic last words a player may drop ("the coral reef" for "the Coral Reef Room"). Never stripped from the Diary Room, so it always reads as the Diary Room. */
const GENERIC_TAIL = /\s+(room|cabin|pod|cave|chamber|suite|quarters)$/;

/**
 * Lowercase phrases for each themed room: the full name, the name without a leading "the", and (when what's left is still unique in the theme) the name without a generic last word.
 * A phrase that would point at two rooms is dropped. Empty without a theme.
 */
export function themedRoomAliases(themeId?: string): ReadonlyArray<readonly [alias: string, room: Room]> {
  const t = houseTheme(themeId);
  if (!t) return [];
  const raw = rawHouseTheme(themeId);  // ORW-968: the name as written still finds the room ("the Captain's Quarters"), so what the narrator or the player already said keeps working
  const byAlias = new Map<string, Set<Room>>();
  const add = (alias: string, room: Room): void => {
    const a = alias.trim().toLowerCase().replace(/\s+/g, " ");
    if (a.length < 3) return;
    for (const form of new Set([a, a.normalize("NFD").replace(/[\u0300-\u036f]/g, "")])) (byAlias.get(form) ?? byAlias.set(form, new Set()).get(form)!).add(room); // "séance" and "seance" both
  };
  for (const [room, { name }] of Object.entries(t.rooms) as Array<[Room, { name: string }]>) {
    if (raw && raw.rooms[room] && raw.rooms[room].name !== name) {
      const rf = raw.rooms[room].name.toLowerCase(); const rb = rf.replace(/^the\s+/, "");
      add(rf, room); add(rb, room);
      if (room !== "diary-room") { const rs = rb.replace(GENERIC_TAIL, ""); if (rs !== rb) { add(rs, room); add(`the ${rs}`, room); } }
    }
    const full = name.toLowerCase();
    const bare = full.replace(/^the\s+/, "");
    add(full, room);
    add(bare, room);
    if (room !== "diary-room") {  // ORW-968: the themed head on its own ("the galley") still finds the room, as it did before the plain word went on
      const head = bare.replace(new RegExp(`\\s+${FUNCTION_WORD[room].toLowerCase().replace(/\s+/g, "\\s+")}$`), "").trim();
      if (head && head !== bare) { add(head, room); add(`the ${head}`, room); }
    }
    if (room !== "diary-room") {
      const short = bare.replace(GENERIC_TAIL, "");
      if (short !== bare) { add(short, room); add(`the ${short}`, room); }
    }
  }
  // ORW-968: a themed alias never takes another room's plain word ("kitchen", "bedroom", "lounge" ...): "go to the kitchen" always means the kitchen, whatever a season's names are.
  const plainOf = new Map<string, Room>(); for (const [r, w] of Object.entries(FUNCTION_WORD) as Array<[Room, string]>) if (r !== "bedroom-b" && r !== "bedroom-c") plainOf.set(w.toLowerCase(), r === "bedroom-a" ? "bedroom-a" : r);
  const notAnotherRoomsWord = (a: string, room: Room): boolean => { const owner = plainOf.get(a.replace(/^the\s+/, "")); return owner === undefined || owner === room || (owner === "bedroom-a" && room.startsWith("bedroom")); };
  return [...byAlias].filter(([a, rooms]) => rooms.size === 1 && notAnotherRoomsWord(a, [...rooms][0]!)).map(([a, rooms]) => [a, [...rooms][0]!] as const).sort((x, y) => y[0].length - x[0].length || x[0].localeCompare(y[0]));
}

/** The season's house theme: one of the library, drawn from `seed` (the same seed always draws the same theme), skipping the ids in `recent` (the player's last seasons) while any are left. */
export function drawHouseTheme(seed: string | number, recent: readonly string[] = []): string {
  const skip = new Set(recent);
  const pool = HOUSE_THEMES.filter((t) => !skip.has(t.id));
  const from = pool.length ? pool : HOUSE_THEMES;
  return from[hashSeed(`${seed}:house-theme`) % from.length]!.id;
}
