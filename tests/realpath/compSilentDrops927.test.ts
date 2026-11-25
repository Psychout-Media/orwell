import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { answerPending } from "../../features/support/answerPending";

/**
 * ORW-927 (Fable's week-2 run): the player answered the competition's approach card and the engine ran the first elimination round(s) inside that press, with no narrator turn in between. Nobody voiced those exits, so the
 * next scene jumped from the full field to "five riders left" and the early drops were never told. The next player message is now told, once, who went out in the rounds nobody voiced (they are named, not scripted).
 * Played through the player channel (a message each turn, every decision answered, advance when due); nothing is set by hand. Roles only.
 */
describe("the drops a comp-round press resolves are told on the next message, once (played)", () => {
  it("the press drops someone with no narrator turn; the next message names them as not yet told; the one after does not", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionRegistry().sandboxFor("comp-silent-drops").session as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    s.createCharacter({ playerName: "The Player", seed: 108 });
    const ctx = (): string => String(s.getMomentPrompt({ moment: "hoh-competition" }).systemPrompt);
    const outNow = (): string[] => (s.getGameState().ceremony.competition?.out ?? []).map((p: { name: string }) => p.name);
    let m = 0, done = false;
    for (let i = 0; i < 6000 && !done; i++) {
      s.noteMessage({ messageId: `m${m++}` });
      const live = s.snapshot().live, g = s.getGameState();
      if (g.pending?.kind === "comp-round" && g.pending.binding !== false) {
        const before = outNow().length;
        const r = answerPending(g.pending);
        s.submitDecision(r);
        const comp = s.getGameState().ceremony.competition;
        const told = (comp?.justOut ?? []).map((p: { name: string }) => p.name);
        expect(outNow().length - before, "the press resolved at least one elimination round").toBeGreaterThan(0);
        expect(told.length, "the drops the press resolved are the not-yet-told ones").toBe(outNow().length - before);
        s.noteMessage({ messageId: `m${m++}` }); // the player's next message: its framing carries them
        const text = ctx();
        expect(text, "this message's context says they have not been voiced").toMatch(/NOT YET TOLD/);
        for (const n of told) expect(text, `${n} is named`).toContain(n);
        s.noteMessage({ messageId: `m${m++}` }); // the one after: told once, not again
        expect(s.getGameState().ceremony.competition?.justOut, "not repeated on the following message").toBeUndefined();
        expect(ctx(), "and the line is gone").not.toMatch(/NOT YET TOLD/);
        done = true;
        continue;
      }
      if (g.pending && g.pending.kind !== "ceremony-step") { const r = answerPending(g.pending); if (r) s.submitDecision(r); continue; }
      if (s.milestoneDue() || g.pending) {
        const v = s.advanceGame();
        if (v.held && ["night", "late-night"].includes(live.timeOfDay)) s.turnIn();
        continue;
      }
      if (["night", "late-night"].includes(live.timeOfDay)) s.turnIn();
    }
    expect(done, "a binding comp-round press was reached and checked").toBe(true);
  }, 120_000);
});
