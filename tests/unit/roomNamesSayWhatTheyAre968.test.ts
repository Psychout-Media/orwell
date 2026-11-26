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
    ["kitchen", "the Galley", "the galley kitchen"], ["kitchen", "the Fudge Kitchen", "the fudge kitchen"], ["kitchen", "the Palace Kitchens", "the palace kitchen"],
    ["kitchen", "the Copper Kettle Galley", "the copper kitchen"], ["dining-room", "the Long Table Hall", "the long dining room"], ["lounge", "Ember Court", "the ember lounge"],
    ["bedroom-a", "the Coral Reef Room", "the coral bedroom"], ["bathroom", "the Bubblegum Bath", "the bubblegum bathroom"], ["bathroom", "the Baths", "the bathroom"],
    ["hoh-room", "the Captain's Quarters", "the HOH room"], ["diary-room", "the Lighthouse Diary Room", "the Diary Room"], ["landing", "Quarterdeck", "the landing"], ["storage-room", "the Hold", "the storage room"],
    ["lounge", "the Room", "the lounge"], ["kitchen", "the 12th Street Kitchen", "the street kitchen"], ["kitchen", "the O'Brien's", "the kitchen"],
  ];
  for (const [room, raw, want] of cases) it(`${room}: "${raw}" -> "${want}"`, () => expect(plainRoomName(room, raw)).toBe(want));
  it("an empty name stays empty", () => expect(plainRoomName("kitchen", "")).toBe(""));
  it("is idempotent: a composed name is kept as it is", () => {
    for (const t of HOUSE_THEMES) for (const r of HOUSE_ROOMS) { const once = plainRoomName(r, t.rooms[r].name); expect(plainRoomName(r, once)).toBe(once); }
  });
});

// The form Ryne asked for ("don't overdo the theming, just cohesive"): the plain word with at most one lowercase themed word in front, or the plain word alone. Nothing else is a shown name: a proper noun or a
// run of words never stands directly in front of the function word.
const FORM = new RegExp(`^the (?:[a-z][a-z-]{1,13} )?(?:${[...new Set(Object.values(PLAIN))].map((w) => w.replace(/\s+/g, "\\s")).join("|")})$`);
describe("the shown names are in the light form, in every house", () => {
  for (const t of HOUSE_THEMES) {
    it(`${t.id}: every library name is already in the form (nothing for the funnel to change), and the HOH room, landing, storage room and Diary Room are the plain word alone`, () => {
      for (const r of HOUSE_ROOMS) {
        const raw = t.rooms[r].name;
        expect(raw, `${t.id}/${r}`).toMatch(FORM);
        expect(plainRoomName(r, raw), `${t.id}/${r}: the library is written in the shown form`).toBe(raw);
      }
      for (const r of ["hoh-room", "landing", "storage-room", "diary-room"] as Room[]) expect(t.rooms[r].name).toBe(`the ${PLAIN[r]}`);
    });
  }
  it("no shown name, library or authored, stacks a capitalised word in front of a function word", () => {
    const names: string[] = [];
    for (const t of HOUSE_THEMES) for (const r of HOUSE_ROOMS) names.push(roomLabel(r, t.id));
    for (const x of names) expect(x, x).not.toMatch(/\b[A-Z][a-z']+ (kitchen|living room|dining room|backyard|hallway|bedroom|bathroom|lounge)\b/);
    expect(names.length).toBe(HOUSE_THEMES.length * HOUSE_ROOMS.length);
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
      for (const r of HOUSE_ROOMS) { expect(says(names[r]!, PLAIN[r]!), `authored ${seed}/${r}: "${names[r]}"`).toBe(true); expect(names[r], `authored ${seed}/${r}`).toMatch(FORM); }
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
