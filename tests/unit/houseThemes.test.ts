import { describe, it, expect } from "vitest";
import { HOUSE_ROOMS } from "../../src/domain/house";
import { HOUSE_THEMES } from "../../src/engine/data/houseThemes";
import { LEGACY_ROOM_NAMES } from "../../src/engine/data/legacyRoomNames";
import { roomLabel, themedRoomAliases, plainRoomName, drawHouseTheme } from "../../src/engine/roomLabels";

/** ORW-466 (Ryne 2026-11-15: "all rooms in the house to be themed"; "Themes should be random"): the season house themes. */
describe("season house themes", () => {
  it("every theme names all 14 rooms, each name unique in its theme, and the Diary Room always reads as the Diary Room", () => {
    expect(HOUSE_THEMES.length).toBeGreaterThanOrEqual(20);
    for (const t of HOUSE_THEMES) {
      const names = HOUSE_ROOMS.map((r) => t.rooms[r]?.name);
      expect(names.every(Boolean), `${t.id} names every room`).toBe(true);
      expect(new Set(names.map((n) => n!.toLowerCase())).size, `${t.id} has no repeated room name`).toBe(14);
      expect(t.rooms["diary-room"].name, `${t.id}`).toMatch(/Diary Room/);
    }
  });

  it("a themed name resolves back to its room, without 'the' and without a generic last word", () => {
    const ocean = HOUSE_THEMES.find((t) => t.id === "ocean-depths")!;
    const alias = new Map(themedRoomAliases(ocean.id));
    expect(alias.get("the coral bedroom")).toBe("bedroom-a");
    expect(alias.get("coral bedroom")).toBe("bedroom-a");
    expect(alias.get("coral")).toBe("bedroom-a"); // the themed word on its own still finds the room
    expect(alias.get("the hoh room")).toBe("hoh-room");
    expect(roomLabel("bedroom-a", ocean.id)).toBe("the coral bedroom");
    expect(roomLabel("bedroom-a")).not.toMatch(/Coral/); // no theme: the plain label
    // the Diary Room is never shortened to a bare themed word, so "lighthouse" alone names no room
    expect(alias.get("lighthouse")).toBeUndefined();
    expect(alias.get("the diary room")).toBe("diary-room");
    // an accented name also answers to its plain spelling
    const manor = HOUSE_THEMES.find((t) => t.id === "midnight-manor")!;
    expect(new Map(themedRoomAliases(manor.id)).get("the seance bedroom")).toBe("bedroom-c");
  });

  it("a phrase that would point at two rooms in one theme is dropped, never guessed", () => {
    // Recount independently: every returned phrase must be a form (full, without "the", without a generic last word, accents off) of exactly ONE room's name in that theme.
    const flat = (x: string) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const formsOf = (name: string, isDiary: boolean): Set<string> => {
      const full = flat(name), bare = full.replace(/^the\s+/, ""), short = bare.replace(/\s+(room|cabin|pod|cave|chamber|suite|quarters)$/, "");
      return new Set([full, bare, ...(isDiary ? [] : [short, `the ${short}`])]);
    };
    // ORW-968: a room's phrases are the forms of the name as written AND of the name said with its plain word ("the Galley kitchen") and the themed head on its own ("the galley")
    const forms968 = (room: string, name: string): Set<string> => {
      const composed = plainRoomName(room as never, name), plain = composed.toLowerCase().replace(/^the\s+/, "");
      const head = plain.replace(/\s+(kitchen|living room|dining room|backyard|hallway|bedroom|bathroom|lounge|hoh room|landing|storage room)$/, "");
      return new Set([...formsOf(name, room === "diary-room"), ...formsOf(composed, room === "diary-room"), head, `the ${head}`, ...(room.startsWith("bedroom") ? [`${head} room`, `the ${head} room`] : [])]); // ORW-1008: players say "the X room" for "the X Bedroom"
    };
    const legacyForms = (themeId: string, room: string): Set<string> => {  // the names the library carried before the light-form pass stay aliases (a season in progress)
      const old = (LEGACY_ROOM_NAMES[themeId] as Record<string, string> | undefined)?.[room];
      return old ? formsOf(old, room === "diary-room") : new Set();
    };
    for (const t of HOUSE_THEMES) {
      const rooms = Object.entries(t.rooms).map(([r, v]) => [r, new Set([...forms968(r, v.name), ...legacyForms(t.id, r)])] as const);
      for (const [a] of themedRoomAliases(t.id)) expect(rooms.filter(([, f]) => f.has(flat(a))).length, `${t.id}: "${a}" names exactly one room`).toBe(1);
    }
  });

  it("the draw is the same for the same season and never repeats a recent season's theme", () => {
    expect(drawHouseTheme(42)).toBe(drawHouseTheme(42));
    const first = drawHouseTheme(42);
    expect(drawHouseTheme(42, [first])).not.toBe(first);
    const seen = new Set(Array.from({ length: 60 }, (_, i) => drawHouseTheme(i)));
    expect(seen.size, "seasons spread over the library").toBeGreaterThan(10);
  });
});
