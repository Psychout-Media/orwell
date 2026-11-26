import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { answerPending } from "../../features/support/answerPending";

/**
 * ORW-928: a season playtest staged the eviction twice. The reveal, the host's words and the evictee's walk were voiced on the turn that committed the result; the context kept offering the
 * same close ("the door, the hug line, the house watching them go") on every later turn of the night, so the player's next message staged the evictee's exit again (a second exit speech).
 * The night is voiced once: the turn that commits the result gets the reveal; each later message says it has ALREADY BEEN VOICED. Played through the player channel (a message each turn,
 * every earlier decision answered, advance when due); nothing is set by hand. Roles only.
 */
const VOICED = /REVEAL AND [^\n]*EXIT HAVE ALREADY BEEN VOICED/;

describe("a committed eviction is not staged again on later turns (played)", () => {
  it("the turn the result lands reads no 'already voiced'; later messages of the night do", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionRegistry().sandboxFor("evict-voiced-once").session as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    s.createCharacter({ playerName: "The Player", seed: 108 });
    const ctx = (): string => { const r = s.getMomentPrompt({ moment: "eviction" }); return `${String(r.systemPrompt)}\n${String(r.hardConstraints ?? "")}`; }; // the committed board rides the terminal block
    let m = 0, firstSeen = false, later = 0;
    const landed = (): void => { // checked right after the engine step, before the player's next message
      if (firstSeen || !s.getGameState().eviction?.evictee) return;
      firstSeen = true;
      expect(ctx(), "the turn that commits the result gets the reveal, not 'already voiced'").not.toMatch(VOICED);
    };
    for (let i = 0; i < 6000 && later < 2; i++) {
      s.noteMessage({ messageId: `m${m++}` });
      const live = s.snapshot().live, g = s.getGameState();
      if (g.eviction?.evictee) {
        expect(firstSeen, "the landing turn was seen first").toBe(true);
        expect(ctx(), "a later message of the night is told the reveal and the exit are already voiced").toMatch(VOICED);
        later++;
        continue; // the player talks again; the night is not restaged
      }
      if (g.pending && g.pending.kind !== "ceremony-step") { const r = answerPending(g.pending); if (r) s.submitDecision(r); landed(); continue; }
      if (s.milestoneDue() || g.pending) {
        const v = s.advanceGame();
        landed();
        if (v.held && ["night", "late-night"].includes(live.timeOfDay)) s.turnIn();
        continue;
      }
      if (["night", "late-night"].includes(live.timeOfDay)) s.turnIn();
    }
    expect(firstSeen, "an eviction result was committed in the played season").toBe(true);
    expect(later, "two later messages of the night were played").toBe(2);
  }, 120_000);
});
