import { describe, it, expect } from "vitest";
import { playUntil, wfScan } from "./playedSeason";
import { firstSeedWhere } from "../support/firstSeedWhere";
import { GameSessionRegistry } from "../../src/composition/registry";

/**
 * ORW-794 - an open alliance pitch must reach the narrator. The only thing that told it was a line in the base prompt ("gameStatus.alliancePitches lists..."), so a pitch the model did not go
 * and look up was never voiced, and an unvoiced pitch cannot be accepted. Real path: the scripted talking player plays seed 1 until a houseguest has let them in on an alliance (an open pitch
 * the engine itself formed and revealed); then the narrator's per-turn moment prompt must name the alliance and its id and say how to take it. Reads only; nothing is set by hand. Roles only.
 */
describe("an open alliance pitch is in the narrator's moment prompt (played)", () => {
  it("while a pitch is open the prompt names it, its id and the lever", async () => {
    const { at } = await firstSeedWhere((seed) => playUntil(seed, (s) => (s.sess.gameStatus().alliancePitches?.length ?? 0) > 0, { user: `wf-${seed}`, maxMessages: 1500 }), wfScan(1, "a houseguest letting the player in on an alliance (an open pitch)"));
    const pitch = at.sess.gameStatus().alliancePitches![0]!;
    const prompt = at.sess.getMomentPrompt({}).systemPrompt as string;
    const line = prompt.split("\n").find((l: string) => l.startsWith("- ALLIANCE PITCH")) ?? "";
    expect(line, "the prompt carries an ALLIANCE PITCH line").not.toBe("");
    expect(line).toContain(pitch.name);
    expect(line).toContain(pitch.id);
    expect(line).toContain("joinAlliance");
    for (const m of pitch.members) expect(line).toContain(m.name); // only the roster the player was told, as in gameStatus
  }, 600_000);
  it("with no pitch open there is no ALLIANCE PITCH line", () => {
    const s = new GameSessionRegistry().sandboxFor("no-pitch").session as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    s.createCharacter({ playerName: "The Player", seed: 5 });
    s.noteMessage({ messageId: "m0" });
    expect(s.gameStatus().alliancePitches).toBeUndefined();
    expect(s.getMomentPrompt({}).systemPrompt as string).not.toContain("- ALLIANCE PITCH");
  });
});
