import { describe, it, expect } from "vitest";
import { playUntil } from "./playedSeason";
import { HOUSE_ROOMS, WALKABLE_ROOMS } from "../../src/domain/house";

/**
 * ORW-968: in a played season the shown room names say what each room is, and they are one name everywhere: the whereabouts view the HUD and map read, the narrator's room lines, and the first-step-in room card
 * (the arrival moment's name and look). A typed "go to the kitchen" moves the player whatever the season's theme. Real path: the scripted talking player; nothing is set by hand. Roles only.
 */
const PLAIN: Record<string, string> = { "kitchen": "kitchen", "living-room": "living room", "dining-room": "dining room", "backyard": "backyard", "hallway": "hallway", "bedroom-a": "bedroom", "bedroom-b": "bedroom", "bedroom-c": "bedroom", "bathroom": "bathroom", "lounge": "lounge", "hoh-room": "HOH room", "landing": "landing", "storage-room": "storage room", "diary-room": "Diary Room" };
const says = (name: string, word: string): boolean => new RegExp(`(^|[^a-z0-9])${word.toLowerCase().replace(/\s+/g, "\\s+")}s?($|[^a-z0-9])`, "i").test(name);

describe("a played season's room names say what each room is (played)", () => {
  it("the HUD's names, the narrator's names and the first-visit card are one plain name each, and the card carries the room's look", async () => {
    const at = await playUntil(1, (s) => !!s.sess.whereabouts()?.roomCard, { user: "wf-1", maxMessages: 1500 });
    const wa = at.sess.whereabouts()!;
    expect(at.sess.live.houseTheme, "this season has a themed house").toBeTruthy();
    for (const r of HOUSE_ROOMS) expect(says(wa.roomNames![r]!, PLAIN[r]!), `${r}: "${wa.roomNames![r]}"`).toBe(true);
    const prompt = at.sess.getMomentPrompt({}).systemPrompt as string;
    const card = wa.roomCard!;
    expect(card.name, "the card names the room by its shown name").toBe(wa.roomNames![wa.room as string]);
    expect(card.look, "and carries its themed look").toBeTruthy();
    const here = prompt.split("\n").find((l: string) => l.includes("Your room:")) ?? "";
    expect(here).toContain(wa.roomNames![wa.room as string]!);
    const cardLine = prompt.split("\n").find((l: string) => l.includes("FIRST VISIT - ROOM CARD")) ?? "";
    expect(cardLine, "the narrator is told to describe the room it has just entered").toContain(card.name);
    for (const r of WALKABLE_ROOMS) expect(prompt, `the narrator's room list names ${r} as the HUD does`).toContain(wa.roomNames![r]!);
  }, 600_000);
  it("a typed 'go to the kitchen' (or the dining room) moves the player in a themed season", async () => {
    const at = await playUntil(1, (s) => !!s.sess.live.houseTheme && s.sess.gameStatus().phase !== "premiere" && !s.sess.getGameState().pending, { user: "wf-1", maxMessages: 1500 });
    const here = at.sess.whereabouts()!.room as string;
    const target = here === "kitchen" ? "dining room" : "kitchen";
    const res = at.sess.resolvePlayerMove({ text: `I go to the ${target}.` });
    expect(res.playerMove, JSON.stringify(res).slice(0, 200)).toMatchObject({ to: target === "kitchen" ? "kitchen" : "dining-room" });
  }, 600_000);
});
