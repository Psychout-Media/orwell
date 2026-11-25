import { describe, it, expect } from "vitest";
import { playedGame } from "../support/playedGame";

/**
 * ORW-913 (Fable's week-1 playtest: on premiere night the player proposed "the Striders" to three houseguests in the bunk room, the narrator voiced each of them swearing in, and the engine never recorded an
 * alliance: the houseguests were strangers, `formAlliance` answered null). REAL PATH: a season is played through the player's levers to the premiere's first evening; the player then proposes a named alliance to
 * three houseguests through the real lever; the engine refuses (not close enough yet) and the NARRATOR is told so on its next prompts, in the world's terms and with no number: nobody is sworn in, take back any
 * "I'm in". The line lasts for the rest of that turn and the next one, then it is gone. Roles only. HEAVY LANE (tests/realpath).
 */
describe("a proposed alliance the engine refused is told to the narrator", () => {
  it("the next prompts say it did not form (and who it was proposed to), and the line is gone two turns on", () => {
    const g = playedGame({ seed: 3, user: "wf-3" });
    g.playUntil(() => (g.s.snapshot() as unknown as { live?: { playedGame?: boolean } }).live?.playedGame === true, 400, "a played game");
    const house = (g.s as unknown as { house: { npcs: Array<{ id: string; name: string }> } }).house;
    const three = house.npcs.slice(0, 3);
    const before = g.s.getMomentPrompt({}).systemPrompt as string;
    expect(before, "no such line before a refusal").not.toContain("ALLIANCE NOT FORMED");
    const view = g.s.formAlliance({ members: three.map((n) => n.id), name: "The Test Group" });
    expect(view, "strangers: the engine refuses").toBeNull();
    const same = g.s.getMomentPrompt({}).systemPrompt as string;
    expect(same, "the rest of that turn").toContain("ALLIANCE NOT FORMED");
    g.s.noteMessage({ messageId: "next-turn" });
    const next = g.s.getMomentPrompt({}).systemPrompt as string;
    expect(next, "the next turn").toContain("ALLIANCE NOT FORMED");
    expect(next).toContain("The Test Group");
    for (const n of three) expect(next, `names who it was proposed to: ${n.name}`).toContain(n.name);
    const line = next.split("\n").find((l) => l.includes("ALLIANCE NOT FORMED"))!;
    expect(line, "no number and no hidden state crosses").not.toMatch(/affinity|trust|bond|npc:\d|\d/i);
    g.s.noteMessage({ messageId: "turn-after" });
    expect(g.s.getMomentPrompt({}).systemPrompt as string, "two turns on it is gone").not.toContain("ALLIANCE NOT FORMED");
  }, 600_000);
});
