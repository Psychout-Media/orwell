import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { HOUSE_ROOMS, type Room } from "../../src/domain/house";
import { HOUSE_EVENT_POOL } from "../../src/engine/houseEvents";
import {
  BASE_HOUSE_MAP, FORBIDDEN_FIXTURE_TERMS, HOUSE_MAP_STATUS, MAX_FIXTURES_PER_ROOM, PROP_CATEGORIES,
  PROP_CATEGORY_LABELS, fixturesForBrief, forbiddenFixtureTerm, roomMapEntry, roomPhrase, validateHouseMap,
  type HouseMap, type RoomFixture, type RoomMapEntry,
} from "../../src/domain/houseFixtures";

/**
 * The house map (Showrunner memory Part B, K4 §1.2 / K9 §1.2): v0 data pending Ryne's sign-off (C1), its
 * validator, and the ~0.1K-token current-room block for the Show Brief. Not wired into the narrator prompt.
 * No names anywhere (rooms and furniture only).
 */

/** K6 §3.3 rule 9: the brief's token estimate is chars / 4.1. */
const tokens = (s: string): number => Math.ceil(s.length / 4.1);

/** The K9 §1.2 table, transcribed. A change here is a content change and needs Ryne's sign-off (C1). */
const K9_TABLE: Record<Room, { fixtures: string[]; props: string[] }> = {
  "kitchen": { fixtures: ["fridge", "pantry cupboard", "island with stools", "stovetop and oven", "microwave", "dishwasher", "double sink", "coffee maker", "toaster", "cabinets", "dish rack"], props: ["drinkware", "food-snack", "towel-linen", "craft-hobby"] },
  "living-room": { fixtures: ["big sectional couch", "armchairs", "coffee table", "area rug", "floor-to-ceiling glass doors to the yard", "console table", "bean bags", "feature wall", "air-conditioner vents", "staircase up to the HOH room"], props: ["drinkware", "food-snack", "book-magazine", "game-toy", "clothing", "footwear", "tech-personal"] },
  "dining-room": { fixtures: ["long dining table", "chairs", "sideboard", "pendant lights", "wall mirror", "fruit bowl"], props: ["drinkware", "food-snack", "book-magazine", "game-toy"] },
  "backyard": { fixtures: ["pool", "hot tub", "pool pump house", "patio furniture and umbrella", "hammock", "grill", "workout bench and weights", "planters", "privacy fence", "sprinkler heads", "pool-deck drain", "string lights"], props: ["drinkware", "towel-linen", "footwear", "book-magazine", "game-toy", "fitness-gear", "plant-flower", "food-snack"] },
  "hallway": { fixtures: ["framed photo wall", "doors to the bedrooms, bathroom and lounge", "laundry alcove with a washer and dryer", "linen closet", "thermostat", "runner rug", "wall mirror"], props: ["towel-linen", "clothing", "footwear", "toiletry"] },
  "bedroom-a": { fixtures: ["beds", "nightstands", "dresser", "closet", "shared hamper", "lamp", "window with blinds", "wall mirror", "themed decor piece"], props: ["clothing", "footwear", "jewelry-accessory", "book-magazine", "toiletry", "tech-personal", "plant-flower", "towel-linen"] },
  "bedroom-b": { fixtures: ["beds", "nightstands", "dresser", "closet", "shared hamper", "lamp", "window with blinds", "wall mirror", "themed decor piece"], props: ["clothing", "footwear", "jewelry-accessory", "book-magazine", "toiletry", "tech-personal", "plant-flower", "towel-linen"] },
  "bedroom-c": { fixtures: ["beds", "nightstands", "dresser", "closet", "shared hamper", "lamp", "window with blinds", "wall mirror", "themed decor piece"], props: ["clothing", "footwear", "jewelry-accessory", "book-magazine", "toiletry", "tech-personal", "plant-flower", "towel-linen"] },
  "bathroom": { fixtures: ["double vanity", "mirrors", "toilet stalls", "shower stalls", "towel hooks", "medicine cabinet", "hamper"], props: ["toiletry", "towel-linen", "jewelry-accessory"] },
  "lounge": { fixtures: ["couches", "window nook", "bookshelf", "board-game shelf", "floor cushions", "small table", "rug"], props: ["book-magazine", "game-toy", "craft-hobby", "drinkware", "plant-flower"] },
  "hoh-room": { fixtures: ["HOH bed", "desk", "armchair", "private bathroom", "closet", "balcony", "mini fridge", "music player and speakers", "window"], props: ["clothing", "jewelry-accessory", "book-magazine", "toiletry", "tech-personal", "drinkware", "plant-flower"] },
  "storage-room": { fixtures: ["metal shelving", "bulk food bins", "cleaning supplies shelf", "mop sink", "spare linens", "costume closet", "folded cots"], props: ["food-snack", "towel-linen", "craft-hobby"] },
  "diary-room": { fixtures: ["the chair", "the camera wall", "soft lighting", "padded door"], props: [] },
};

/** A mutable copy of the base map with one room's entry replaced (for the validator's negative cases). */
function withRoom(room: Room, entry: RoomMapEntry): HouseMap {
  const m = new Map(BASE_HOUSE_MAP);
  m.set(room, entry);
  return m;
}
function withFixtures(room: Room, fixtures: RoomFixture[]): HouseMap {
  return withRoom(room, { ...BASE_HOUSE_MAP.get(room)!, fixtures });
}
const fx = (id: string, label: string, extra: Partial<RoomFixture> = {}): RoomFixture => ({ id, label, aliases: [], kind: "furniture", ...extra });

describe("the v0 house map (K9 §1.2, pending Ryne sign-off C1)", () => {
  it("is marked v0 pending Ryne's sign-off", () => {
    expect(HOUSE_MAP_STATUS).toBe("v0 — pending Ryne sign-off (C1)");
    expect(readFileSync("src/domain/houseFixtures.ts", "utf8")).toContain("v0 — pending Ryne sign-off (C1)");
  });

  it("validates clean", () => {
    expect(validateHouseMap(BASE_HOUSE_MAP)).toEqual([]);
  });

  it("covers exactly the 13 house rooms, in house order", () => {
    expect([...BASE_HOUSE_MAP.keys()]).toEqual([...HOUSE_ROOMS]);
  });

  it("is the K9 §1.2 table, transcribed (fixture labels and prop categories, in order)", () => {
    for (const room of HOUSE_ROOMS) {
      const entry = BASE_HOUSE_MAP.get(room)!;
      expect(entry.fixtures.map((f) => f.label), room).toEqual(K9_TABLE[room].fixtures);
      expect([...entry.allowedProps], room).toEqual(K9_TABLE[room].props);
    }
  });

  it("keeps every room within 1..12 fixtures, and the diary room private (no props)", () => {
    for (const [room, entry] of BASE_HOUSE_MAP) {
      expect(entry.fixtures.length, room).toBeGreaterThan(0);
      expect(entry.fixtures.length, room).toBeLessThanOrEqual(MAX_FIXTURES_PER_ROOM);
      if (room === "diary-room") expect(entry.allowedProps).toEqual([]);
      else expect(entry.allowedProps.length, room).toBeGreaterThan(0);
    }
  });

  it("covers the fixtures the house-event pool already names (K9 §1.2 check)", () => {
    const labels = [...BASE_HOUSE_MAP.values()].flatMap((e) => e.fixtures.map((f) => f.label.toLowerCase().replace(/-/g, " ")));
    const pool = HOUSE_EVENT_POOL.join(" ").toLowerCase().replace(/-/g, " ");
    for (const word of ["pantry", "thermostat", "hammock", "pool pump", "air conditioner", "costume closet"]) {
      expect(pool, `the event pool still names "${word}"`).toContain(word);
      expect(labels.some((l) => l.includes(word)), `a fixture covers "${word}"`).toBe(true);
    }
  });

  it("has no TV, no internet, no phone (NO LIVE MEDIA); the HOH music player is the one exception", () => {
    const all = [...BASE_HOUSE_MAP.values()].flatMap((e) => e.fixtures.flatMap((f) => [f.label, ...f.aliases]));
    for (const text of all) expect(text, text).not.toMatch(/\b(tv|television|internet|wi-?fi|phone|computer|laptop|radio)\b/i);
    expect(BASE_HOUSE_MAP.get("hoh-room")!.fixtures.map((f) => f.label)).toContain("music player and speakers");
  });

  it("names no engine-only thing anywhere (hidden places, plot devices)", () => {
    for (const e of BASE_HOUSE_MAP.values()) {
      for (const f of e.fixtures) for (const t of [f.label, ...f.aliases]) expect(forbiddenFixtureTerm(t), `${f.id}: ${t}`).toBeUndefined();
    }
    for (const c of PROP_CATEGORIES) expect(forbiddenFixtureTerm(PROP_CATEGORY_LABELS[c]), c).toBeUndefined();
  });

  it("only zoned rooms carry fixture zones, and every fixture id is <room>.<slug>", () => {
    for (const [room, entry] of BASE_HOUSE_MAP) {
      for (const f of entry.fixtures) {
        expect(f.id.startsWith(`${room}.`), f.id).toBe(true);
        if (f.zone !== undefined) expect(["backyard", "lounge"]).toContain(room);
      }
    }
    expect(roomMapEntry("backyard")!.fixtures.find((f) => f.label === "hot tub")!.zone).toBe("poolside");
  });
});

describe("validateHouseMap catches every problem class", () => {
  const one = (map: HouseMap): string => {
    const p = validateHouseMap(map);
    expect(p.length, JSON.stringify(p)).toBe(1);
    return p[0]!;
  };

  it("a missing room", () => {
    const m = new Map(BASE_HOUSE_MAP);
    m.delete("lounge");
    expect(one(m)).toBe("lounge: missing from the map");
  });

  it("a key that is not a house room", () => {
    const m = new Map(BASE_HOUSE_MAP) as Map<Room, RoomMapEntry>;
    m.set("cellar" as Room, { room: "cellar" as Room, fixtures: [], allowedProps: [] });
    expect(one(m)).toBe("cellar: not a house room");
  });

  it("an entry filed under another room", () => {
    expect(one(withRoom("kitchen", { ...BASE_HOUSE_MAP.get("kitchen")!, room: "dining-room" }))).toBe('kitchen: entry names room "dining-room"');
  });

  it("an empty room and an over-full room", () => {
    expect(one(withFixtures("kitchen", []))).toBe("kitchen: lists no fixtures");
    const many = Array.from({ length: MAX_FIXTURES_PER_ROOM + 1 }, (_, i) => fx(`kitchen.item-${i}`, `item ${i}`));
    expect(one(withFixtures("kitchen", many))).toBe("kitchen: lists more than 12 fixtures");
  });

  it("a malformed, foreign or duplicated fixture id", () => {
    expect(one(withFixtures("lounge", [fx("lounge.Bad Slug", "couches")]))).toContain('fixture id "lounge.Bad Slug" is not "lounge.<slug>"');
    expect(one(withFixtures("lounge", [fx("kitchen.couch", "couches")]))).toContain('fixture id "kitchen.couch" is not "lounge.<slug>"');
    expect(one(withFixtures("lounge", [fx("lounge.couch", "couches"), fx("lounge.couch", "rug")]))).toBe('lounge: fixture id "lounge.couch" is used twice');
  });

  it("an unknown kind or a zone the room does not have", () => {
    expect(one(withFixtures("lounge", [fx("lounge.couch", "couches", { kind: "portal" as never })]))).toBe('lounge.couch: unknown kind "portal"');
    expect(one(withFixtures("lounge", [fx("lounge.couch", "couches", { zone: "poolside" })]))).toBe('lounge.couch: zone "poolside" is not a zone of lounge');
    expect(one(withFixtures("kitchen", [fx("kitchen.sink", "sink", { zone: "poolside" })]))).toBe('kitchen.sink: zone "poolside" is not a zone of kitchen');
  });

  it("an empty, multi-line, untrimmed or over-long label", () => {
    expect(one(withFixtures("lounge", [fx("lounge.couch", "")]))).toBe("lounge.couch label: empty text");
    expect(one(withFixtures("lounge", [fx("lounge.couch", "couch\nand more")]))).toBe("lounge.couch label: text must be one trimmed line");
    expect(one(withFixtures("lounge", [fx("lounge.couch", " couch")]))).toBe("lounge.couch label: text must be one trimmed line");
    expect(one(withFixtures("lounge", [fx("lounge.couch", "c".repeat(61))]))).toBe("lounge.couch label: longer than 60 characters");
  });

  it("an engine-only term in a label or an alias (a hidden place, a plot device)", () => {
    expect(one(withFixtures("backyard", [fx("backyard.hatch", "hatch in the lawn")]))).toBe('backyard.hatch label: contains the engine-only term "hatch"');
    expect(one(withFixtures("backyard", [fx("backyard.door", "garden door", { aliases: ["trap  door"] })]))).toBe('backyard.door alias 0: contains the engine-only term "trap  door"');
    expect(one(withFixtures("hallway", [fx("hallway.panel", "secret panel")]))).toBe('hallway.panel label: contains the engine-only term "secret"');
  });

  it("the same name twice in one room (labels and aliases, case-insensitive)", () => {
    expect(one(withFixtures("lounge", [fx("lounge.couch", "couches"), fx("lounge.sofa", "Couches")]))).toBe('lounge.sofa label: "Couches" is listed twice in lounge');
    expect(one(withFixtures("lounge", [fx("lounge.couch", "couches", { aliases: ["sofa"] }), fx("lounge.sofa", "sofa")]))).toBe('lounge.sofa label: "sofa" is listed twice in lounge');
  });

  it("an unknown or repeated prop category, and props in the private diary room", () => {
    expect(one(withRoom("kitchen", { ...BASE_HOUSE_MAP.get("kitchen")!, allowedProps: ["drinkware", "treasure" as never] }))).toBe('kitchen: unknown prop category "treasure"');
    expect(one(withRoom("kitchen", { ...BASE_HOUSE_MAP.get("kitchen")!, allowedProps: ["drinkware", "drinkware"] }))).toBe('kitchen: prop category "drinkware" is listed twice');
    expect(one(withRoom("diary-room", { ...BASE_HOUSE_MAP.get("diary-room")!, allowedProps: ["drinkware"] }))).toBe("diary-room: is private and must carry no props");
  });
});

describe("forbiddenFixtureTerm is word-bounded", () => {
  it.each([
    ["a hatch", "hatch"], ["a garden shed", "shed"], ["a trapdoor", "trapdoor"], ["a crawl space", "crawl space"],
    ["the gate", "gate"], ["a lockbox", "lockbox"], ["SAFE", "safe"], ["a spike strip", "spike strip"],
  ])("flags %s", (text, term) => expect(forbiddenFixtureTerm(text)).toBe(term));

  it.each(["keyboard", "monkey bars", "safety rail", "gatefold", "framed photo wall", "air-conditioner vents", "notebook shelf", "mapleleaf rug"])(
    "does not flag %s", (text) => expect(forbiddenFixtureTerm(text)).toBeUndefined(),
  );

  it("covers K9's named engine-only words", () => {
    for (const w of ["hatch", "tunnel", "trapdoor", "safe", "plate"]) expect(FORBIDDEN_FIXTURE_TERMS).toContain(w);
  });
});

describe("fixturesForBrief: the current room, about 0.1K tokens", () => {
  it("renders every room within ~0.1K tokens, listing every fixture in order and ending the list positively", () => {
    let max = 0;
    for (const room of HOUSE_ROOMS) {
      const text = fixturesForBrief(room)!;
      max = Math.max(max, tokens(text));
      expect(tokens(text), `${room}: ${tokens(text)} tokens`).toBeLessThanOrEqual(120);
      const labels = BASE_HOUSE_MAP.get(room)!.fixtures.map((f) => f.label);
      expect(text.split("\n")[0]).toContain(labels.join("; "));
      expect(text).toContain("That is the whole list.");
      // Positive-only (K4 D7): the block never names an engine-only thing, not even to forbid it.
      expect(forbiddenFixtureTerm(text), room).toBeUndefined();
    }
    expect(max).toBeGreaterThan(60); // the budget is real, not vacuous
  });

  it("is deterministic and matches the golden text for the backyard and the diary room", () => {
    expect(fixturesForBrief("backyard")).toBe(fixturesForBrief("backyard"));
    expect(fixturesForBrief("backyard")).toBe(
      "Built into the backyard: pool; hot tub; pool pump house; patio furniture and umbrella; hammock; grill; workout bench and weights; " +
      "planters; privacy fence; sprinkler heads; pool-deck drain; string lights. That is the whole list.\n" +
      "Loose things that may be lying around: drinks and mugs, towels, shoes and flip-flops, books and magazines, cards and games, " +
      "workout gear, plants and flowers, snacks.",
    );
    expect(fixturesForBrief("diary-room")).toBe(
      "Built into the diary room: the chair; the camera wall; soft lighting; padded door. That is the whole list.\nNothing loose lies around in here.",
    );
  });

  it("names rooms the way people say them (no article before a lettered bedroom)", () => {
    expect(fixturesForBrief("bedroom-b")!.startsWith("Built into bedroom B: beds;")).toBe(true);
    expect(fixturesForBrief("hoh-room")!.startsWith("Built into the HOH room: HOH bed;")).toBe(true);
    expect(roomPhrase("living-room")).toBe("the living room");
    expect(roomPhrase("bedroom-a")).toBe("bedroom A");
  });

  it("never prints aliases (they are for the later sentence gate)", () => {
    expect(fixturesForBrief("backyard")).not.toMatch(/jacuzzi|bbq|irrigation/);
  });

  it("returns undefined for a room the map does not know, or one with nothing built in", () => {
    expect(fixturesForBrief("cellar" as Room)).toBeUndefined();
    expect(fixturesForBrief("kitchen", withFixtures("kitchen", []))).toBeUndefined();
    expect(roomMapEntry("cellar" as Room)).toBeUndefined();
  });
});
