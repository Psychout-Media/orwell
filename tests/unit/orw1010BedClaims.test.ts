import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { parsePlayerBedIntent } from "../../src/engine/bedClaims";
import { resolvePending } from "../../features/support/answerPending";

/** ORW-1010: beds on move-in night. Roles only; no fixture names or player chat. */
type Live = { premiereEntrance?: { stage: string }; beds?: { owner: Record<string, string>; claims: unknown[] }; bedRush?: { tick: number; done?: boolean } };
const liveOf = (s: GameSessionAdapter) => (s as unknown as { live: Live }).live;
const step = (s: GameSessionAdapter) => { const v = s.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req)); };
let n = 0;
function circleClosed(seed: number): GameSessionAdapter {
  const s = new GameSessionRegistry().sandboxFor(`orw1010-${n++}`).session as GameSessionAdapter;
  s.setPremiereEntrancesEnabled(true);
  s.setBedRushEnabled(true);
  s.createCharacter({ playerName: "P", seed });
  s.noteMessage({ messageId: "m1" });
  for (let i = 0; i < 60 && liveOf(s).premiereEntrance!.stage !== "done"; i++) step(s);
  expect(liveOf(s).premiereEntrance!.stage).toBe("done");
  return s;
}
const prompt = (s: GameSessionAdapter): string => String((s.getMomentPrompt({}) as { systemPrompt: string }).systemPrompt);

const rooms = [{ room: "bedroom-b" as never, names: ["palmetto bedroom", "palmetto room", "palmetto"] }];
const people = [{ id: "npc:1", names: ["Alex"] }];

describe("ORW-1010: the player's plain claim of half of a double is read", () => {
  for (const text of [
    "I'll take half of the double in the Palmetto room.",
    "I want the other half of the double in the palmetto bedroom",
    "I claim a double in Palmetto.",
    "I'll sleep in the double in the palmetto room",
    "I grab a spot in the Palmetto room, the double.",
  ]) {
    it(`reads: ${text}`, () => {
      expect(parsePlayerBedIntent(text, rooms, people)).toMatchObject({ kind: "claim", room: "bedroom-b" });
    });
  }
  it("still reads nothing from hedged or unrelated talk", () => {
    expect(parsePlayerBedIntent("Maybe I'll take half of the double in Palmetto later.", rooms, people)).toBeNull();
    expect(parsePlayerBedIntent("I take a seat in the Palmetto room.", rooms, people)).toBeNull();
  });
});

describe("ORW-1010: a refused claim is told to the narrator to say plainly, with the reason", () => {
  it("from the common area after the circle: the prompt carries a refusal line with the reason; a successful claim carries none", () => {
    const s = circleClosed(7);
    // the claim alone, without the pre-move that walks the player there (the engine had them elsewhere, as in ORW-1008)
    (s as unknown as { resolvePlayerBed(t: string): boolean }).resolvePlayerBed("I'll take half of the double in bedroom B.");
    expect(liveOf(s).beds?.owner["player"], "no bed: the player was not in the room").toBeUndefined();
    expect(prompt(s)).toMatch(/BED REQUEST REFUSED[^\n]*not reached[^\n]*say so plainly/);
    (s as unknown as { resolvePlayerBed(t: string): boolean }).resolvePlayerBed("I think about the house.");
    expect(prompt(s), "the refusal lasts the one turn").not.toMatch(/BED REQUEST REFUSED/);
  });
});

describe("ORW-1010: after the circle the narrator's facts carry the beds really claimed", () => {
  it("once a heat has run, the BEDS line lists each room's real sleepers", () => {
    const s = circleClosed(7);
    for (let i = 0; i < 3; i++) step(s);
    const claims = Object.keys(liveOf(s).beds!.owner).filter((w) => w !== "player");
    expect(claims.length, "positive control: houseguests claimed").toBeGreaterThan(0);
    const line = prompt(s).split("\n").find((l) => l.startsWith("- BEDS")) ?? "";
    expect(line).toMatch(/PER-BED TABLE[^\n]*(?:single|double \d half \d): [A-Z][a-z]+ /); // ORW-1153: the per-bed table, each spot with its real owner
    expect(line).toMatch(/FREE SPOTS HOUSE-WIDE: \d+ of \d+/);
  });
});
