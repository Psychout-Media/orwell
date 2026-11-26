import { describe, it, expect } from "vitest";
import { HOUSE_ROOMS, WALKABLE_ROOMS, resolveRoom, roomDisplayName, type Room } from "../../src/domain/house";
import { HOUSE_THEMES } from "../../src/engine/data/houseThemes";
import { acceptHouseThemeDraft, plainRoomName, registerHouseTheme, roomLabel, roomNamesFor, roomRef, themedRoomAliases } from "../../src/engine/roomLabels";

/**
 * ORW-968 (Ryne, live playtest 2026-11-26: "Copper Kettle Galley, maybe the kitchen ... Ember Court, no clue"): every room's shown name says what the room is, in plain words (kitchen, dining room, bedroom ...);
 * the theme is a light modifier in front of it, never the whole name. One funnel (`houseTheme()` in roomLabels.ts) feeds the HUD, the narrator, the NPCs and movement, so the name is the same everywhere.
 * Over EVERY theme the generator can make: the 24 library houses and any house the writer authors. Roles only.
 */
const PLAIN: Readonly<Record<string, string>> = {
  "kitchen": "kitchen", "living-room": "living room", "dining-room": "dining room", "backyard": "backyard", "hallway": "hallway", "bedroom-a": "bedroom", "bedroom-b": "bedroom", "bedroom-c": "bedroom",
  "bathroom": "bathroom", "lounge": "lounge", "hoh-room": "HOH room", "landing": "landing", "storage-room": "storage room", "diary-room": "Diary Room",
};
const says = (name: string, word: string): boolean => new RegExp(`(^|[^a-z0-9])${word.toLowerCase().replace(/\s+/g, "\\s+")}s?($|[^a-z0-9])`, "i").test(name);

describe("every library house says what each room is", () => {
  for (const t of HOUSE_THEMES) {
    it(`${t.id}: every shown name contains its plain word, the names are one per room, and one name reads the same everywhere`, () => {
      const names = roomNamesFor(t.id)!;
      const seen = new Set<string>();
      for (const r of HOUSE_ROOMS) {
        expect(says(names[r]!, PLAIN[r]!), `${t.id}/${r}: "${names[r]}" does not say "${PLAIN[r]}"`).toBe(true);
        expect(roomLabel(r, t.id), "roomLabel and roomNamesFor are one name").toBe(names[r]);
        expect(roomRef(r, t.id), "mid-sentence the same name, never 'the the'").toBe(names[r]);
        expect(names[r]).not.toMatch(/^the the /i);
        seen.add(names[r]!.toLowerCase());
      }
      expect(seen.size, "no two rooms share a name").toBe(HOUSE_ROOMS.length);
    });
    it(`${t.id}: "go to the <plain word>" finds the right room, and the full shown name finds it too`, () => {
      const aliases = themedRoomAliases(t.id);
      const names = roomNamesFor(t.id)!;
      for (const r of WALKABLE_ROOMS) {
        const plain = resolveRoom(`the ${PLAIN[r]!.toLowerCase()}`, null, aliases);
        if (r.startsWith("bedroom")) expect(plain.kind === "ok" ? [plain.room] : plain.kind === "ambiguous" ? plain.candidates : []).toContain(r);
        else expect(plain, `${t.id}: "the ${PLAIN[r]}" must find ${r}`).toEqual({ kind: "ok", room: r });
        expect(resolveRoom(names[r]!, null, aliases), `${t.id}: "${names[r]}" must find ${r}`).toEqual({ kind: "ok", room: r });
      }
      expect(resolveRoom("bedroom A", null, aliases)).toEqual({ kind: "ok", room: "bedroom-a" });
    });
  }
});

describe("the composition itself (any name the season may carry)", () => {
  const cases: Array<[Room, string, string]> = [
    ["kitchen", "the Galley", "the Galley kitchen"], ["kitchen", "the Fudge Kitchen", "the Fudge Kitchen"], ["kitchen", "the Palace Kitchens", "the Palace Kitchens"],
    ["bedroom-a", "the Coral Reef Room", "the Coral Reef bedroom"], ["hoh-room", "the Captain's Quarters", "the Captain's HOH room"], ["bathroom", "the Bubblegum Bath", "the Bubblegum bathroom"],
    ["bathroom", "the Baths", "the bathroom"], ["diary-room", "the Lighthouse Diary Room", "the Lighthouse Diary Room"], ["diary-room", "the Magic Mirror", "the Magic Mirror Diary Room"],
    ["landing", "Quarterdeck", "the Quarterdeck landing"], ["storage-room", "the Hold", "the Hold storage room"],
  ];
  for (const [room, raw, want] of cases) it(`${room}: "${raw}" -> "${want}"`, () => expect(plainRoomName(room, raw)).toBe(want));
  it("never leaves a room unnamed, and an empty or word-only name is just the plain word", () => {
    expect(plainRoomName("kitchen", "")).toBe("");
    expect(plainRoomName("lounge", "the Room")).toBe("the lounge");
  });
  it("is idempotent: a composed name is kept as it is", () => {
    for (const t of HOUSE_THEMES) for (const r of HOUSE_ROOMS) { const once = plainRoomName(r, t.rooms[r].name); expect(plainRoomName(r, once)).toBe(once); }
  });
});

describe("a house the writer authors reads the same way", () => {
  // seeded, composed drafts: random heads from random words, with the endings that used to stand in for the room ("Hall", "Court", "Galley", "Room", "Suite" ...)
  const HEADS = ["Ember", "Copper Kettle", "Long Table", "Moss", "Cinder", "Velvet", "Salt", "Harbor Light", "Quiet", "Brass", "Thistle", "North Wind", "Lantern"];
  const ENDS = ["Hall", "Court", "Galley", "Room", "Suite", "Nook", "Den", "Loft", "Annex", "Quarters", "Deck", "Parlor", "Bay", "Cellar", "Bath", ""];
  const rngFor = (seed: number) => { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 0xffffffff; }; };
  it("across 60 seeded authored houses: every accepted house's rooms say their plain word and resolve", () => {
    let accepted = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const rnd = rngFor(seed * 7919);
      const rooms: Record<string, { name: string; look: string }> = {};
      HOUSE_ROOMS.forEach((r, i) => { const head = HEADS[Math.floor(rnd() * HEADS.length)]!; const end = ENDS[Math.floor(rnd() * ENDS.length)]!; rooms[r] = { name: `the ${head} ${end}`.trim() + ` ${i}`, look: `A themed room number ${i}, with details enough to pass the length rule.` }; });
      const verdict = acceptHouseThemeDraft({ name: `Authored House ${seed}`, pitch: "An authored house for the naming test, long enough to be accepted.", rooms });
      if (!verdict.accepted) continue;
      accepted++;
      registerHouseTheme(verdict.theme!);
      const id = verdict.theme!.id;
      const names = roomNamesFor(id)!;
      for (const r of HOUSE_ROOMS) expect(says(names[r]!, PLAIN[r]!), `authored ${seed}/${r}: "${names[r]}"`).toBe(true);
      const aliases = themedRoomAliases(id);
      for (const r of WALKABLE_ROOMS) {
        const plain = resolveRoom(`the ${PLAIN[r]!.toLowerCase()}`, null, aliases);
        if (r.startsWith("bedroom")) expect(plain.kind === "ok" ? [plain.room] : plain.kind === "ambiguous" ? plain.candidates : []).toContain(r);
        else expect(plain).toEqual({ kind: "ok", room: r });
      }
    }
    expect(accepted, "the loop reached accepted houses").toBeGreaterThan(20);
  });
  it("the plain label is still what an un-themed season says", () => {
    for (const r of HOUSE_ROOMS) expect(roomLabel(r, undefined)).toBe(roomDisplayName(r));
  });
});
