import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { answerPending } from "../../features/support/answerPending";

/**
 * ORW-837 (found by the ORW-812 real-path rewrite): an eviction night the player starts near dawn must run to its result. A person plays seed 108 (a message each turn, every decision answered,
 * events advanced when due, bed at night) up to the eviction coming due, then stays up past 7:30am and only then starts it. Its first steps cross the 8am wake; the schedule used to HOLD the rest
 * (remaining reveal, goodbye, result) until 4pm, so the house sat eight hours mid-reveal. A running ceremony is never held: once the night starts it runs to its result. Nothing set by hand. Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

describe("a running eviction is never held by the schedule (played)", () => {
  it("an eviction started after 7:30am runs to its result with no schedule hold mid-ceremony", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionRegistry().sandboxFor("running-ceremony-played").session as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    s.createCharacter({ playerName: "The Player", seed: 108 });
    let m = 0, stayedUp = false;
    for (let i = 0; i < 8000 && !stayedUp; i++) {
      s.noteMessage({ messageId: `m${m++}` });
      const live = s.snapshot().live, g = s.getGameState();
      if (g.pending && g.pending.kind !== "ceremony-step") { const r = answerPending(g.pending); if (r) s.submitDecision(r); continue; }
      if (live.beat === "eviction" && s.milestoneDue()) {
        if (live.nightDepth >= 31.5) stayedUp = true;
        continue;
      }
      if (s.milestoneDue() || g.pending) { const v = s.advanceGame(); if (v.held && ["night", "late-night"].includes(live.timeOfDay)) s.turnIn(); continue; }
      if (["night", "late-night"].includes(live.timeOfDay)) s.turnIn();
    }
    expect(stayedUp, "the player reached 7:30am with the eviction still due").toBe(true);
    let result = false, heldMidCeremony = 0, started = false;
    for (let i = 0; i < 2000 && !result; i++) {
      const running = !!s.snapshot().live.eviction;
      const v = s.advanceGame();
      if (s.snapshot().live.eviction) started = true;
      if (v.held) {
        if (running) heldMidCeremony++; // held while an eviction was already under way
        s.noteMessage({ messageId: `w${m++}` });
        continue;
      }
      if (v.pending && v.pending.kind !== "ceremony-step") { const r = answerPending(v.pending); if (r) s.submitDecision(r); }
      if (v.event?.beat === "eviction-result") result = true;
    }
    expect(started, "the eviction night started").toBe(true);
    expect(result, "the eviction ran to its result").toBe(true);
    expect(heldMidCeremony, "no advance was held by the schedule while the eviction was running").toBe(0);
  }, 120_000);
});
