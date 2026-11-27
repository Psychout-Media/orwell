import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { HOUSE_THEMES } from "../../src/engine/data/houseThemes";
import { themedRoomAliases } from "../../src/engine/roomLabels";
import { parsePlayerMoveIntent, parsePlayerOwnBedMove } from "../../src/engine/playerMoveIntent";
import { claimBed } from "../../src/engine/beds";
import { freeBedIn } from "../../src/engine/bedClaims";
import type { Room } from "../../src/domain/house";

/**
 * ORW-1008 (prod 2026-11-26): the player's own words decide the player's own move, in four classes:
 *  - affiliation ("my bed is in the X room", "I'm in my room") never moves the player;
 *  - an explicit request to go moves them, committed before the reply (the ORW-419 seam), whatever the themed name or the wording of the room;
 *  - negation, the future and quoted speech never move them;
 *  - a themed room name (and "the X room" for "the X Bedroom") resolves.
 * Table-driven, through the real parser and the real `resolvePlayerMove`. Season: ocean-depths (bedroom-b is "the deep bedroom"); the player's bed is in bedroom-b.
 */
const THEME = "ocean-depths";
type Row = { cls: "affiliation" | "move" | "negation" | "future" | "quoted" | "themed" | "own-bed" | "question"; text: string; here?: Room; to: Room | null };

const ROWS: Row[] = [
  // affiliation: where the bed is, which room is mine, where I am: no verb of movement
  { cls: "affiliation", text: "My bed is in the deep bedroom.", to: null },
  { cls: "affiliation", text: "I'm in the deep room, that's where my bed is.", to: null },
  { cls: "affiliation", text: "I sleep in the deep bedroom.", to: null },
  { cls: "affiliation", text: "my bed is in the deep room btw", to: null },
  { cls: "affiliation", text: "The deep room is my room.", to: null },
  { cls: "affiliation", text: "I'm in my room.", to: null },
  { cls: "affiliation", text: "That's my bed over there.", to: null },
  { cls: "affiliation", text: "I have the bed by the window in the deep bedroom.", to: null },
  { cls: "affiliation", text: "My room is the deep room and my bed is the single one.", to: null },
  { cls: "affiliation", text: "Everyone knows my bed is in the deep bedroom, so ask Sam about it.", to: null },
  { cls: "affiliation", text: "I live in the deep bedroom with Sam.", to: null },
  { cls: "affiliation", text: "I'm in the deep bedroom's group chat.", to: null },
  { cls: "affiliation", text: "Which room is my bed in? The deep one, right?", to: null },
  { cls: "affiliation", text: "my bed", to: null },
  { cls: "affiliation", text: "I claimed a bed! Jump on yours too! Im in the deep room!", to: null },
  { cls: "affiliation", text: "Im in the deep bedroom now, come see my bed", to: null },
  // explicit movement: committed before the reply, themed and plain names
  { cls: "move", text: "Let's go to the deep bedroom.", to: "bedroom-b" },
  { cls: "move", text: "let's go to the deep room", to: "bedroom-b" },
  { cls: "move", text: "Let's go to the deep room with Sam and Alex.", to: "bedroom-b" },
  { cls: "move", text: "I go to the kitchen", to: "kitchen" },
  { cls: "move", text: "I head to the deep room", to: "bedroom-b" },
  { cls: "move", text: "I walk into the hallway and look around.", to: "hallway" },
  { cls: "move", text: "take me to the lounge", to: "lounge" },
  { cls: "move", text: "ok let's go to the backyard", to: "backyard" },
  { cls: "move", text: "I want to go to the deep bedroom, come with me", to: "bedroom-b" },
  { cls: "move", text: "I'm going to the bathroom.", to: "bathroom" },
  { cls: "move", text: "Let's all go to the deep room and talk.", to: "bedroom-b" },
  { cls: "move", text: "I go find Sam in the dining room.", to: "dining-room" },
  { cls: "move", text: "Let's head into the deep bedroom, I want to show you something.", to: "bedroom-b" },
  { cls: "move", text: "I walk to the deep room.", to: "bedroom-b" },
  { cls: "move", text: "i go to the kitchen, then i come back", to: "kitchen" },
  { cls: "move", text: "Let's go to the deep bedroom. Then we can chat.", to: "bedroom-b" },
  { cls: "move", text: "I head over to the bedroom b", to: "bedroom-b" },
  { cls: "move", text: "Lets go to the deep room.", to: "bedroom-b" },
  { cls: "move", text: "Im going to the kitchen", to: "kitchen" },
  { cls: "move", text: "I step into the deep room quietly", to: "bedroom-b" },
  // own bed / own room as a destination of a go-verb
  { cls: "own-bed", text: "I go back to my bed.", to: "bedroom-b" },
  { cls: "own-bed", text: "I head to my room", to: "bedroom-b" },
  { cls: "own-bed", text: "Let's go to my room.", to: "bedroom-b" },
  { cls: "own-bed", text: "I walk over to my bed and sit down.", to: "bedroom-b" },
  { cls: "own-bed", text: "take me to my room", to: "bedroom-b" },
  { cls: "own-bed", text: "I'm going to my bed.", to: "bedroom-b" },
  // negation
  { cls: "negation", text: "I don't want to go to the deep room.", to: null },
  { cls: "negation", text: "I'm not going to the kitchen.", to: null },
  { cls: "negation", text: "I won't head to my bed yet.", to: null },
  { cls: "negation", text: "Let's not go to the deep bedroom.", to: null },
  { cls: "negation", text: "Don't go to the deep room, stay here.", to: null },
  { cls: "negation", text: "I never go to the backyard.", to: null },
  { cls: "negation", text: "I can't go to the hallway right now.", to: null },
  { cls: "negation", text: "I refuse to walk to my room.", to: null },
  { cls: "negation", text: "no way I'm going to my bed", to: null },
  // future / later / conditional
  { cls: "future", text: "I'll go to the deep room later.", to: null },
  { cls: "future", text: "Maybe I should head to the kitchen.", to: null },
  { cls: "future", text: "Tomorrow I go to my bed early.", to: null },
  { cls: "future", text: "When dinner is over let's go to the deep bedroom.", to: null },
  { cls: "future", text: "If Sam leaves I'll go to the lounge.", to: null },
  { cls: "future", text: "I might walk to my room after the meeting.", to: null },
  { cls: "future", text: "Later we should go to the deep room.", to: null },
  { cls: "future", text: "I plan to go to the backyard tonight.", to: null },
  { cls: "future", text: "I'll go back to my bed once everyone is asleep.", to: null },
  { cls: "future", text: "Someday I want to walk into the deep bedroom.", to: null },
  // quoted speech
  { cls: "quoted", text: "I tell Sam \"let's go to the deep room\" and stay put.", to: null },
  { cls: "quoted", text: "Sam says “go to your bed” but I ignore her.", to: null },
  { cls: "quoted", text: "I whisper \"I head to the kitchen\" to myself.", to: null },
  { cls: "quoted", text: "\"Let's go to the deep bedroom,\" she said, and I rolled my eyes.", to: null },
  { cls: "quoted", text: "She asked \"are we going to my bed?\" and I laughed.", to: null },
  // questions
  { cls: "question", text: "Can we go to the deep room?", to: null },
  { cls: "question", text: "Should I go to my bed?", to: null },
  { cls: "question", text: "Is my bed in the deep bedroom?", to: null },
  { cls: "question", text: "What's in the deep room?", to: null },
  // themed names and aliases
  { cls: "themed", text: "I go to the deep bedroom", to: "bedroom-b" },
  { cls: "themed", text: "I go to deep room", to: "bedroom-b" },
  { cls: "themed", text: "I go to the coral reef room", to: "bedroom-a" },
  { cls: "themed", text: "I head to the coral bedroom", to: "bedroom-a" },
  { cls: "themed", text: "let's go to the wreck room", to: "bedroom-c" },
  { cls: "themed", text: "I walk to the wreck bedroom", to: "bedroom-c" },
  { cls: "themed", text: "I go to the tidepool bathroom", to: "bathroom" },
  { cls: "themed", text: "Let's go to the kelp lounge", to: "lounge" },
  { cls: "themed", text: "I go to the sandbar", to: "backyard" },
];

function session(here: Room): GameSessionAdapter {
  const s = new GameSessionAdapter();
  s.createCharacter({ playerName: "The Player", seed: 31 });
  const live = (s as unknown as { live: { champagneCircle?: string; playedGame?: boolean; houseTheme?: string; beds?: { owner: Record<string, string>; claims: unknown[] } } }).live;
  live.champagneCircle = undefined;
  live.houseTheme = THEME;
  live.playedGame = true;
  const beds = (s as unknown as { ensureBeds(): { owner: Record<string, string>; claims: unknown[] } }).ensureBeds()!;
  const living = new Set(s.livingIds());
  delete beds.owner["player"];
  const spot = freeBedIn(beds as never, "bedroom-b", living);
  if (spot) claimBed(beds as never, "player", spot, 1, "move-in", living);
  s.movePlayer(here);
  return s;
}

describe("ORW-1008: the player's own move, by class (real parser and resolvePlayerMove)", () => {
  expect(ROWS.length).toBeGreaterThanOrEqual(60);
  it.each(ROWS.map((r, i) => [i, r.cls, r.text, r] as const))("#%i %s: %s", (_i, _c, _t, r) => {
    const here: Room = r.here ?? "living-room";
    const s = session(here);
    const bedRoom = (s as unknown as { live: { beds: { owner: Record<string, string> } } }).live.beds.owner["player"];
    expect(bedRoom, "the player has a bed in bedroom-b").toMatch(/^bedroom-b/);
    const res = s.resolvePlayerMove({ text: r.text });
    const now = s.whereabouts()!.room;
    if (r.to === null) {
      expect(res.playerMove, "no move").toBeNull();
      expect(now).toBe(here);
    } else {
      expect(res.playerMove, "moved before the reply").toMatchObject({ from: here, to: r.to });
      expect(now).toBe(r.to);
      expect(s.getGameState().playerMove).toMatchObject({ to: r.to }); // the narrator is handed the committed room
    }
  });

  it("the parsers agree: affiliation parses to no move, own-bed destination is only a go-verb", () => {
    const al = themedRoomAliases(THEME);
    for (const r of ROWS.filter((x) => x.cls === "affiliation")) {
      expect(parsePlayerMoveIntent(r.text, "living-room", al), r.text).toBeNull();
      expect(parsePlayerOwnBedMove(r.text), r.text).toBe(false);
    }
    for (const r of ROWS.filter((x) => x.cls === "own-bed")) expect(parsePlayerOwnBedMove(r.text), r.text).toBe(true);
  });

  it("an explicit request is not vetoed by where the player was: from the bathroom, 'the deep room' moves him to bedroom-b (the prod miss)", () => {
    const s = session("bathroom");
    const r = s.resolvePlayerMove({ text: "Let's go to the deep room" });
    expect(r.playerMove).toMatchObject({ from: "bathroom", to: "bedroom-b" });
  });

  it("the HOUSE theme library: every bedroom answers to 'the <head> room' where its name ends in Bedroom", () => {
    for (const t of HOUSE_THEMES) {
      const al = new Map(themedRoomAliases(t.id));
      for (const [alias, room] of al) if (alias.endsWith(" bedroom") && !alias.startsWith("the ")) {
        const head = alias.replace(/ bedroom$/, "");
        const want = al.get(`${head} room`);
        if (want !== undefined) expect(want, `${t.id}: ${head} room`).toBe(room);
      }
    }
  });
});
