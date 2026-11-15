import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { HOUSE_THEMES } from "../../src/engine/data/houseThemes";

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
    expect(wa.roomNames?.["bedroom-a"]).toBe("the Coral Reef Room");
    expect(wa.roomLook).toBe(OCEAN.rooms[here].look);
    const prompt = s.getMomentPrompt({}).systemPrompt;
    expect(prompt).toContain(OCEAN.rooms[here].name);
    expect(prompt).toContain("the Captain's Quarters");
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
