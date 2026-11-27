import { describe, it, expect } from "vitest";
import { playUntil, firstStop, wfScan } from "./playedSeason";
import { GameSessionRegistry } from "../../src/composition/registry";

/**
 * ORW-851 (leftover of ORW-794): a favor the player is owed, and a vote pitch a houseguest has floated, were told to the narrator only through gameStatus (it had to call the tool and read the field), so one the model did
 * not go and look up was never voiced. The moment prompt now carries a line for each from the view's own fields. Real path: the scripted talking player plays a seed until the engine itself reaches the state (a favor owed
 * to them after a kept deal; a vote pitch the engine floated), then the narrator's per-turn moment prompt must name it. Reads only; nothing is set by hand. Roles only.
 */
describe("owed favors and an open vote pitch are in the narrator's moment prompt (played)", () => {
  it("while a favor is owed the prompt names who owes it and the lever", async () => {
    const at = await playUntil(1, (s) => (s.sess.gameStatus().owedFavors?.length ?? 0) > 0, { user: "wf-1", maxMessages: 1500 });
    const owed = at.sess.gameStatus().owedFavors!;
    const line = (at.sess.getMomentPrompt({}).systemPrompt as string).split("\n").find((l: string) => l.startsWith("- FAVORS OWED TO THE PLAYER")) ?? "";
    expect(line, "the prompt carries the owed-favors line").not.toBe("");
    for (const f of owed) { expect(line).toContain(f.from.name); expect(line).toContain(`(${f.n})`); }
    expect(line).toContain("callInFavor");
  }, 600_000);
  it("while a vote pitch is open the prompt names who floated it and what they ask", async () => {
    const at = await firstStop((s) => !!s.sess.gameStatus().openVotePitch, wfScan([10, 1, 5], "an open vote pitch"), { maxMessages: 1500 }); // ORW-880: picked, not pinned (a gameplay change moves which season floats one)
    const pitch = at.sess.gameStatus().openVotePitch!;
    const line = (at.sess.getMomentPrompt({}).systemPrompt as string).split("\n").find((l: string) => l.startsWith("- VOTE PITCH OPEN")) ?? "";
    expect(line, "the prompt carries the vote-pitch line").not.toBe("");
    expect(line).toContain(pitch.from.name);
    expect(line).toContain(pitch.terms);
  }, 600_000);
  it("with nothing owed and no pitch there is neither line", () => {
    const s = new GameSessionRegistry().sandboxFor("no-fav-pitch").session as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    s.createCharacter({ playerName: "The Player", seed: 5 });
    s.noteMessage({ messageId: "m0" });
    const text = s.getMomentPrompt({}).systemPrompt as string;
    expect(text).not.toContain("- FAVORS OWED TO THE PLAYER");
    expect(text).not.toContain("- VOTE PITCH OPEN");
  });
});
