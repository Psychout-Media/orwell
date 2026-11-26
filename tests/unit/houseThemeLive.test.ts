import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { HOUSE_THEMES } from "../../src/engine/data/houseThemes";
import { resolveRoom } from "../../src/domain/house";
import { themedRoomAliases, roomNamesFor } from "../../src/engine/roomLabels";
import { parsePlayerMoveIntent } from "../../src/engine/playerMoveIntent";

/** ORW-466 (Ryne 2026-11-15: "Themes should be random"; "all rooms in the house to be themed as well"): the season's house theme in a live game. Roles only. A test-only seam on `live`. */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(false));
type Live = { houseTheme?: string; priorHouseThemes?: string[]; playedGame?: boolean };
const liveOf = (s: GameSessionAdapter) => (s as unknown as { live: Live }).live;
const OCEAN = HOUSE_THEMES.find((t) => t.rooms["bedroom-a"].name === "the Coral Reef Room")!;

function game(seed = 11) {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const sb = new GameSessionRegistry().sandboxFor(`theme-${Math.random()}`);
  const s = sb.session as GameSessionAdapter;
  s.createCharacter({ playerName: "P", seed });
  return { s, sb };
}

describe("the season's house theme", () => {
  it("is drawn when a person starts playing - the same season draws the same theme - and a headless game has none", () => {
    const a = game(11).s, b = game(11).s, headless = game(11).s;
    a.noteMessage({ messageId: "m1" }); b.noteMessage({ messageId: "m1" });
    expect(liveOf(a).houseTheme).toBeTruthy();
    expect(liveOf(b).houseTheme).toBe(liveOf(a).houseTheme);
    expect(liveOf(headless).houseTheme).toBeUndefined();
  });

  it("the narrator is told the player's room by its themed name with its look, the walkable rooms by theme, and a themed name moves the player", () => {
    const { s } = game();
    s.noteMessage({ messageId: "m1" });
    liveOf(s).houseTheme = OCEAN.id; // pin the theme so the names are known
    const wa = s.whereabouts()!;
    const here = wa.room as keyof typeof OCEAN.rooms; // wherever the player stands (gathered for the premiere, a move is held)
    expect(wa.roomNames?.["bedroom-a"]).toBe("the Coral Reef bedroom"); // ORW-968: said with its plain word
    expect(wa.roomLook).toBe(OCEAN.rooms[here].look);
    // the house search's facts use the season's name too ("here with you in the Coral Reef Room", never "the bedroom a")
    const withMe = (s.whereabouts({ search: true })?.search?.houseguests ?? []).filter((h) => h.status === "here");
    expect(withMe.length).toBeGreaterThan(0);
    for (const h of withMe) expect(h.fact).toContain(roomNamesFor(OCEAN.id)![here]!);
    const prompt = s.getMomentPrompt({}).systemPrompt;
    expect(prompt).toContain(roomNamesFor(OCEAN.id)![here]!);
    expect(prompt).toContain("the Captain's HOH room");
    expect(prompt).toContain(`This season it looks like this (dress the scene with it; never read it out as a list): ${OCEAN.rooms[here].look}`); // review of #2856: no "this this season"
    expect(prompt).not.toMatch(/bedroom a\b/i);
    const r = s.resolvePlayerMove({ text: "I head to the coral reef" });
    expect(r.playerMove).toMatchObject({ to: "bedroom-a" });
  });

  it("a new season (the real restart door) avoids the last season's theme", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const reg = new GameSessionRegistry();
    const user = `theme-restart-${Math.random()}`;
    const s = reg.sandboxFor(user).session as GameSessionAdapter;
    s.createCharacter({ playerName: "P", seed: 5 });
    s.noteMessage({ messageId: "m1" });
    const first = liveOf(s).houseTheme!;
    s.createCharacter({ playerName: "P", seed: 5, confirmRestart: true });
    const n = reg.sandboxFor(user).session as GameSessionAdapter;
    expect(liveOf(n).priorHouseThemes).toContain(first);
    n.noteMessage({ messageId: "m2" });
    expect(liveOf(n).houseTheme, "the same seed would draw the same theme; the recent one is skipped").not.toBe(first);
  });
});

describe("a themed room name resolves however it is typed (review of #2856)", () => {
  const ocean = themedRoomAliases(OCEAN.id);
  it("a curly apostrophe is the straight one, in the room resolver and in the player's own move", () => {
    expect(resolveRoom("the Captain\u2019s Quarters", null, ocean)).toEqual({ kind: "ok", room: "hoh-room" });
    expect(parsePlayerMoveIntent("I head to the Captain\u2019s Quarters", "kitchen", ocean)).toBe("hoh-room");
  });
  it("a themed name that starts with an article the resolver drops still resolves by its own name", () => {
    expect(resolveRoom("A Velvet Vault", null, [["a velvet vault", "lounge"]])).toEqual({ kind: "ok", room: "lounge" });
  });
});
