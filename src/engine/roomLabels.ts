/**
 * ORW-466 - the season's room names (Ryne 2026-11-15: "all rooms in the house to be themed"; "Themes should be random"). Pure: no I/O, no shared randomness.
 *
 * - `roomLabel`: what a room is called this season (its themed name), or today's plain label when the season has no theme.
 * - `themedRoomAliases`: the lowercase phrases a player (or the narrator) can use for a themed room, so "the Coral Reef" resolves like "bedroom A" does.
 * - `drawHouseTheme`: the season's theme, drawn from the seed (reproducible), never one of the player's recent seasons' themes.
 */
import { roomDisplayName, type Room } from "../domain/house";
import { HOUSE_THEMES, type HouseTheme } from "./data/houseThemes";
import { hashSeed } from "./characterFactory";

export function houseTheme(themeId: string | undefined): HouseTheme | undefined {
  return themeId ? HOUSE_THEMES.find((t) => t.id === themeId) : undefined;
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
    (byAlias.get(a) ?? byAlias.set(a, new Set()).get(a)!).add(room);
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
