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

export function houseTheme(themeId: string | undefined): HouseTheme | undefined {
  return themeId ? (HOUSE_THEMES.find((t) => t.id === themeId) ?? AUTHORED_THEMES.get(themeId)) : undefined;
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
    const x = d.rooms[r];
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
  const byAlias = new Map<string, Set<Room>>();
  const add = (alias: string, room: Room): void => {
    const a = alias.trim().toLowerCase().replace(/\s+/g, " ");
    if (a.length < 3) return;
    for (const form of new Set([a, a.normalize("NFD").replace(/[\u0300-\u036f]/g, "")])) (byAlias.get(form) ?? byAlias.set(form, new Set()).get(form)!).add(room); // "séance" and "seance" both
  };
  for (const [room, { name }] of Object.entries(t.rooms) as Array<[Room, { name: string }]>) {
    const full = name.toLowerCase();
    const bare = full.replace(/^the\s+/, "");
    add(full, room);
    add(bare, room);
    if (room !== "diary-room") {
      const short = bare.replace(GENERIC_TAIL, "");
      if (short !== bare) { add(short, room); add(`the ${short}`, room); }
    }
  }
  return [...byAlias].filter(([, rooms]) => rooms.size === 1).map(([a, rooms]) => [a, [...rooms][0]!] as const).sort((x, y) => y[0].length - x[0].length || x[0].localeCompare(y[0]));
}

/** The season's house theme: one of the library, drawn from `seed` (the same seed always draws the same theme), skipping the ids in `recent` (the player's last seasons) while any are left. */
export function drawHouseTheme(seed: string | number, recent: readonly string[] = []): string {
  const skip = new Set(recent);
  const pool = HOUSE_THEMES.filter((t) => !skip.has(t.id));
  const from = pool.length ? pool : HOUSE_THEMES;
  return from[hashSeed(`${seed}:house-theme`) % from.length]!.id;
}
