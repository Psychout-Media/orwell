import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { answerPending } from "../../features/support/answerPending";

/**
 * ORW-859 (716b): a season playtest narrated the HOH competition's call scene three turns running. While the player's approach card was open the narrator's context kept saying
 * "IT IS TIME: the HOH competition is starting NOW - production calls the whole house", so each message the player typed re-staged the call and the competition itself was never reached.
 * The call is voiced once (the turn the event comes due); once the game has opened the event and waits on the player, the context says it has ALREADY been called.
 * Played through the player channel (a message each turn, every earlier decision answered, advance when due); nothing is set by hand. Roles only.
 */
const CALL = /IT IS TIME:[^\n]*starting NOW/;
const CALLED = /HAS ALREADY BEEN CALLED/;

describe("a called competition is not called again while the player's card is open (played)", () => {
  it("due with no card: the call line stands; with the approach card open, three turns of talk never re-issue the call", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionRegistry().sandboxFor("comp-call-once").session as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    s.createCharacter({ playerName: "The Player", seed: 108 });
    const ctx = (): string => String(s.getMomentPrompt({ moment: "hoh-competition" }).systemPrompt);
    let m = 0, control = false, checked = 0;
    for (let i = 0; i < 6000 && checked < 3; i++) {
      s.noteMessage({ messageId: `m${m++}` });
      const live = s.snapshot().live, g = s.getGameState();
      if (g.pending?.kind === "comp-round" && live.week >= 2) {
        const text = ctx();
        expect(control, "the control: the same event was seen due with no card, and the call line stood").toBe(true);
        expect(text, "the call is not re-issued while the card is open").not.toMatch(CALL);
        expect(text, "the context says the event has already been called").toMatch(CALLED);
        checked++;
        continue; // the player talks again and does not answer the card
      }
      if (g.pending && g.pending.kind !== "ceremony-step") { const r = answerPending(g.pending); if (r) s.submitDecision(r); continue; }
      if (s.milestoneDue() || g.pending) {
        if (live.week >= 2 && live.beat === "hoh-competition" && !g.pending && CALL.test(ctx())) control = true;
        const v = s.advanceGame();
        if (v.held && ["night", "late-night"].includes(live.timeOfDay)) s.turnIn();
        continue;
      }
      if (["night", "late-night"].includes(live.timeOfDay)) s.turnIn();
    }
    expect(checked, "the approach card was reached and three turns were played with it open").toBe(3);
  }, 120_000);
});
