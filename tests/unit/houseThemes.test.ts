import { describe, it, expect } from "vitest";
import { HOUSE_ROOMS } from "../../src/domain/house";
import { HOUSE_THEMES } from "../../src/engine/data/houseThemes";
import { roomLabel, themedRoomAliases, drawHouseTheme } from "../../src/engine/roomLabels";

/** ORW-466 (Ryne 2026-11-15: "all rooms in the house to be themed"; "Themes should be random"): the season house themes. */
describe("season house themes", () => {
  it("every theme names all 13 rooms, each name unique in its theme, and the Diary Room always reads as the Diary Room", () => {
    expect(HOUSE_THEMES.length).toBeGreaterThanOrEqual(20);
    for (const t of HOUSE_THEMES) {
      const names = HOUSE_ROOMS.map((r) => t.rooms[r]?.name);
      expect(names.every(Boolean), `${t.id} names every room`).toBe(true);
      expect(new Set(names.map((n) => n!.toLowerCase())).size, `${t.id} has no repeated room name`).toBe(13);
      expect(t.rooms["diary-room"].name, `${t.id}`).toMatch(/Diary Room/);
    }
  });

  it("a themed name resolves back to its room, without 'the' and without a generic last word", () => {
    const ocean = HOUSE_THEMES.find((t) => t.rooms["bedroom-a"].name === "the Coral Reef Room")!;
    const alias = new Map(themedRoomAliases(ocean.id));
    expect(alias.get("the coral reef room")).toBe("bedroom-a");
    expect(alias.get("coral reef")).toBe("bedroom-a");
    expect(alias.get("captain's quarters")).toBe("hoh-room");
    expect(roomLabel("bedroom-a", ocean.id)).toBe("the Coral Reef Room");
    expect(roomLabel("bedroom-a")).not.toMatch(/Coral/); // no theme: the plain label
  });

  it("the draw is the same for the same season and never repeats a recent season's theme", () => {
    expect(drawHouseTheme(42)).toBe(drawHouseTheme(42));
    const first = drawHouseTheme(42);
    expect(drawHouseTheme(42, [first])).not.toBe(first);
    const seen = new Set(Array.from({ length: 60 }, (_, i) => drawHouseTheme(i)));
    expect(seen.size, "seasons spread over the library").toBeGreaterThan(10);
  });
});
