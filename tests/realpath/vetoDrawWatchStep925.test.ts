import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { answerPending } from "../../features/support/answerPending";

/**
 * ORW-925 (Fable week 1, turn 142): the player TYPED "I walk down for the veto player draw" while the draw's watch step ("the chips are being drawn") was pending. The narrator got the whole draw script and read every chip
 * aloud before the engine drew, naming a field the game did not have. While that step is pending the context says the draw has not happened and the chips wait for Continue; once the engine has drawn, the script is back.
 * Played through the player channel (a message each turn, every decision answered, advance when due); nothing set by hand. Roles only.
 */
describe("the veto draw is not narrated while its watch step waits for Continue (played)", () => {
  it("a message at the chips step gets the not-happened note; after the engine draws, the draw script returns", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionRegistry().sandboxFor("veto-draw-watch").session as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    s.createCharacter({ playerName: "The Player", seed: 108 });
    const ctx = (): string => String(s.getMomentPrompt({ moment: "veto-draw" }).systemPrompt);
    let m = 0, done = false;
    for (let i = 0; i < 6000 && !done; i++) {
      s.noteMessage({ messageId: `m${m++}` });
      const live = s.snapshot().live, g = s.getGameState();
      const p = g.pending;
      if (p?.kind === "ceremony-step" && p.ceremony?.kind === "veto-draw" && p.ceremony.stepId === "chips") {
        expect(g.ceremony.veto.players.length, "the engine has not drawn").toBe(0);
        const text = ctx();
        expect(text, "the draw is said not to have happened").toMatch(/veto draw has NOT happened yet/);
        expect(text, "and the chips wait for Continue").toMatch(/presses Continue/);
        s.advanceGame(); // the Continue press: the engine draws
        s.noteMessage({ messageId: `m${m++}` });
        expect(s.getGameState().ceremony.veto.players.length, "the engine drew").toBeGreaterThan(0);
        expect(ctx(), "once drawn, the note is gone").not.toMatch(/veto draw has NOT happened yet/);
        done = true;
        continue;
      }
      if (p && p.kind !== "ceremony-step") { const r = answerPending(p); if (r) s.submitDecision(r); continue; }
      if (s.milestoneDue() || p) {
        const v = s.advanceGame();
        if (v.held && ["night", "late-night"].includes(live.timeOfDay)) s.turnIn();
        continue;
      }
      if (["night", "late-night"].includes(live.timeOfDay)) s.turnIn();
    }
    expect(done, "the veto draw's chips step was reached and checked").toBe(true);
  }, 150_000);
});
