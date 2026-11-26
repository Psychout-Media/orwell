import { describe, it, expect, afterEach, vi, type MockInstance } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { answerPending } from "../../features/support/answerPending";

/**
 * PO ruling 2026-11-01 (eviction night takes about two in-game hours) - a night is counted once, even when an event's later steps sit at 8am. ORW-812: played, not set by hand (the
 * old test wrote the clock to 7:30am). A person plays seed 108 (a message each turn, every decision answered, events advanced when due, bed at night) up to the eviction coming
 * due; then they stay up through the night, messaging, past 7:30am, and only then start the eviction. Its first step crosses the 8am wake; the night's fatigue accrues exactly
 * once. The rest of the event-clock checks stay in tests/unit/eventClockBudget.test.ts. Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

describe("a night is counted once, even when an event's later steps sit at 8am (played)", () => {
  it("an eviction night the player stays up through until 7:30am accrues the night's fatigue exactly once", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionRegistry().sandboxFor("night-once-played").session as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    s.createCharacter({ playerName: "The Player", seed: 108 });
    let m = 0, stayedUp = false;
    for (let i = 0; i < 8000 && !stayedUp; i++) {
      s.noteMessage({ messageId: `m${m++}` });
      const live = s.snapshot().live, g = s.getGameState();
      if (g.pending && g.pending.kind !== "ceremony-step") { const r = answerPending(g.pending); if (r) s.submitDecision(r); continue; }
      if (live.beat === "eviction" && s.milestoneDue()) { // the eviction is due: the player does not start it, and does not go to bed
        if (live.nightDepth >= 31.5) stayedUp = true;
        continue;
      }
      if (s.milestoneDue() || g.pending) { const v = s.advanceGame(); if (v.held && ["night", "late-night"].includes(live.timeOfDay)) s.turnIn(); continue; }
      if (["night", "late-night"].includes(live.timeOfDay)) s.turnIn();
    }
    expect(stayedUp, "the player reached 7:30am with the eviction still due").toBe(true);
    const accrue = vi.spyOn(GameSessionAdapter.prototype as never, "accrueNightFatigue" as never) as unknown as MockInstance;
    try {
      let result = false;
      for (let i = 0; i < 2000 && !result; i++) {
        const v = s.advanceGame();
        if (v.held) { s.noteMessage({ messageId: `w${m++}` }); continue; } // the rest of the night is held to its scheduled hour: the player lives the day meanwhile
        if (v.pending && v.pending.kind !== "ceremony-step") { const r = answerPending(v.pending); if (r) s.submitDecision(r); }
        if (v.event?.beat === "eviction-result") result = true;
      }
      expect(result, "the eviction ran to its result").toBe(true);
      expect(accrue.mock.calls.length, "one night, one accrual").toBe(1);
    } finally {
      accrue.mockRestore();
    }
  }, 120_000);
  // ORW-812 finding: here the vote and the first reveal step run at 7:35am, the reveal's own hours carry the clock past the 8am wake, and the rest of the eviction (the remaining reveal,
  // the goodbye, the result) is then HELD by the schedule until 4pm: one eviction night split across a day, the house waiting eight hours mid-reveal.
  it.todo("real path: an eviction started in the small hours finishes as one night - finding: once its steps cross the 8am wake the rest is held to the next evening (ORW-812)");
});
