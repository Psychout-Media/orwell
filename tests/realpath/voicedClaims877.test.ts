import { describe, it, expect } from "vitest";
import { playedGame } from "../support/playedGame";
import { firstSeedWhereSync } from "../support/firstSeedWhere";

/**
 * ORW-877 (the T2-12 front-end half of ORW-594), REAL PATH: a told claim joins the player's knowledge only once the narration voiced it. A season is played through the player's levers; each turn
 * the narrator's view is built (`presentKnowledgeForPrompt`, the prompt build) and the turn's narration is handed back the way the front end does after every narrated turn
 * (`recordNarrationUse`). The first tell the house hands the narrator is then either voiced (the narration names the speaker and who it is about) or not. Two copies of the same game
 * (same seed, same sandbox name) take the two answers at the same moment. Nothing is set by hand. Roles only.
 */
type Claim = { speaker: string; listener: string; kind: string; subject: string; week: number; day?: number };
type Peek = {
  live: { claims?: { items: Claim[] }; dayNumber?: number };
  presentKnowledgeForPrompt(): Array<{ id: string; name: string; tellsYou?: { kind: string; subject: string } }>;
  recordNarrationUse(r: { text: string }): unknown;
};
const QUIET = "The kitchen hums along. Somebody laughs in the next room and the afternoon drifts on.";
const toPlayer = (s: Peek, speaker: string): Claim[] => (s.live.claims?.items ?? []).filter((c) => c.listener === "player" && c.speaker === speaker);

/** Play with the front end's echo on every turn (quiet narration) until the house hands the narrator a tell; stop there, before this turn's echo. */
function toFirstTell(seed: number, sandbox: string): { s: Peek; tell: { speaker: string; speakerName: string; subjectName: string; kind: string }; before: number; beforeToday: number } | undefined {
  const g = playedGame({ seed, user: sandbox });
  const s = g.s as unknown as Peek;
  let tell: { speaker: string; speakerName: string; subjectName: string; kind: string } | undefined;
  let before = 0, beforeToday = 0;
  let seen = 0;
  g.playUntil(() => {
    const n0 = s.live.claims?.items.length ?? 0;
    const view = s.presentKnowledgeForPrompt() ?? [];
    const items = s.live.claims?.items ?? [];
    // a claim told to the player at THIS prompt build: not one already said earlier this turn (logged before the build), and not a couple sighting (passed on as knowledge, not a claim)
    const e = view.find((x) => x.tellsYou && x.tellsYou.kind !== "couple-with" && !items.slice(seen, n0).some((c) => c.listener === "player" && c.speaker === x.id && c.kind === x.tellsYou!.kind));
    seen = items.length;
    if (e) { tell = { speaker: e.id, speakerName: e.name, subjectName: e.tellsYou!.subject, kind: e.tellsYou!.kind }; before = toPlayer(s, e.id).filter((c) => items.indexOf(c) < n0).length; beforeToday = toPlayer(s, e.id).filter((c) => items.indexOf(c) < n0 && c.day === s.live.dayNumber).length; return true; }
    s.recordNarrationUse({ text: QUIET });
    return false;
  }, 900, "a tell handed to the narrator");
  return tell ? { s, tell, before, beforeToday } : undefined;
}

describe("ORW-877 REAL PATH: the player hears a told claim only if the narration voiced it", () => {
  it("unvoiced: never enters the player's knowledge and leaves the day's slot free; voiced: enters it exactly once", () => {
    // ORW-1043: the game the scan stopped IS the first copy (stopped before this turn's echo, untouched since), so it is not played a second time
    const { seed, sandbox, at: quiet } = firstSeedWhereSync(toFirstTell, { from: 1, to: 4, hint: [7], sandbox: (x) => `t931-${x}`, what: "a tell handed to the narrator" });
    // the narration does not voice it
    expect(toPlayer(quiet.s, quiet.tell.speaker), "held at the prompt build: not yet in the player's knowledge").toHaveLength(quiet.before);
    quiet.s.recordNarrationUse({ text: QUIET });
    expect(toPlayer(quiet.s, quiet.tell.speaker), "an unvoiced tell never enters the player's knowledge").toHaveLength(quiet.before);
    // the day's slot: what the speaker has told the player today is what it was before this tell (nothing of it was logged)
    expect(toPlayer(quiet.s, quiet.tell.speaker).filter((c) => c.day === quiet.s.live.dayNumber).length, "the day's slot is left as it was").toBe(quiet.beforeToday);
    // the narration voices it (the same game at the same moment)
    const voiced = toFirstTell(seed, sandbox)!;
    expect(voiced.tell).toEqual(quiet.tell);
    const line = `${voiced.tell.speakerName} leans in and tells you something about ${voiced.tell.subjectName}.`;
    voiced.s.recordNarrationUse({ text: line });
    const after = toPlayer(voiced.s, voiced.tell.speaker);
    expect(after, "a voiced tell enters the player's knowledge").toHaveLength(voiced.before + 1);
    expect(after[after.length - 1]!.kind).toBe(voiced.tell.kind);
    voiced.s.recordNarrationUse({ text: line });
    expect(toPlayer(voiced.s, voiced.tell.speaker), "exactly once").toHaveLength(voiced.before + 1);
  }, 600_000);

  it("a session that never echoes (headless) tells at the prompt build, as before", () => {
    const g = playedGame({ seed: 1, user: "t877-1" });
    const s = g.s as unknown as Peek;
    let hit: { id: string } | undefined;
    g.playUntil(() => !!(hit = (s.presentKnowledgeForPrompt() ?? []).find((x) => x.tellsYou)), 900, "a tell");
    expect(toPlayer(s, hit!.id).length).toBeGreaterThan(0);
  }, 600_000);
});
