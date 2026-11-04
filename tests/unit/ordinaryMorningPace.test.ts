import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { MINUTES_PER_MESSAGE, MESSAGE_MINUTES_BAND, MESSAGES_PER_MORNING } from "../../src/engine/sleepConstants";
import { milestoneDue } from "../../src/engine/daySchedule";

/**
 * P4c (PO ruling, Ryne 2026-11-04): the clock ticks DURING a conversation, a few in-game minutes per message ("if it takes 2 minutes to read 3 messages and that's 3 hours
 * of in-game time, I'm pissed"): ~5 min/message => ~48 messages per 4h block. The narrator's feltMinutes may only NUDGE a message within a small band (3-8 min), never
 * bill hours, and never adjusts how long a conversation runs. Conversation types emerge from how many messages they run. Roles only.
 */
describe("the per-message pace", () => {
  it("is ~5 in-game minutes a message, ~48 messages a morning, with a small nudge band", () => {
    expect(MINUTES_PER_MESSAGE).toBe(5);
    expect(MESSAGES_PER_MORNING).toBe(48);
    expect(MESSAGE_MINUTES_BAND).toEqual({ min: 3, max: 8 });
  });
});

describe("a scripted chat morning", () => {
  afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));
  function morning(): GameSessionAdapter {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionRegistry().sandboxFor(`pace-${Math.random()}`).session;
    s.createCharacter({ playerName: "P", archetype: "floater", seed: 7 });
    s.setPerConversationClockEnabled(true);
    s.advanceGame(); s.advanceGame();                 // premiere -> the day starts at 8am
    return s;
  }
  const hour = (s: GameSessionAdapter): number => s.snapshot().live?.nightDepth ?? 0;

  it("48 ordinary messages take 8am to noon; the afternoon event is not due one message earlier (even mid-conversation)", () => {
    const s = morning();
    expect(hour(s)).toBe(8);
    for (let i = 0; i < 47; i++) s.advanceClockPerConversation();
    expect(milestoneDue(s.snapshot().live)).toBe(false);
    expect(hour(s)).toBeLessThan(12);
    s.advanceClockPerConversation();
    expect(hour(s)).toBeCloseTo(12, 5);
    expect(milestoneDue(s.snapshot().live)).toBe(true);
  });

  it("a narrator felt proposal only nudges a message within the 3-8 minute band, never hours", () => {
    const s = morning();
    s.stashPendingFeltHours(4);                        // a 4h "summit" proposal
    s.advanceClockPerConversation();
    expect((hour(s) - 8) * 60).toBeCloseTo(MESSAGE_MINUTES_BAND.max, 5);
    const mid = hour(s);
    s.stashPendingFeltHours(0.25);                     // a quick word
    s.advanceClockPerConversation();
    expect((hour(s) - mid) * 60).toBeCloseTo(MESSAGE_MINUTES_BAND.min, 5);
    const m2 = hour(s);
    s.advanceClockPerConversation();                   // no proposal: the plain pace
    expect((hour(s) - m2) * 60).toBeCloseTo(MINUTES_PER_MESSAGE, 5);
  });
});

describe("P4c regression + behaviour (AMEND time-stack v2 tests 2-4)", () => {
  afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));
  function day(): GameSessionAdapter {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionRegistry().sandboxFor(`pace2-${Math.random()}`).session;
    s.createCharacter({ playerName: "P", archetype: "floater", seed: 7 });
    s.setPerConversationClockEnabled(true);
    s.advanceGame(); s.advanceGame();
    return s;
  }
  const hour = (s: GameSessionAdapter): number => s.snapshot().live?.nightDepth ?? 0;

  it("the PO's case: 3 ordinary messages advance the clock ~15 minutes, never hours", () => {
    const s = day();
    for (let i = 0; i < 3; i++) s.advanceClockPerConversation();
    const mins = (hour(s) - 8) * 60;
    expect(mins).toBeCloseTo(15, 5);
    expect(mins).toBeLessThan(30); // a hard upper bound: never hours
  });

  it("even with the biggest proposals, 3 messages stay under 3 x the band max (24 minutes)", () => {
    const s = day();
    for (let i = 0; i < 3; i++) { s.stashPendingFeltHours(4); s.advanceClockPerConversation({ kind: "summit", proposedHours: 4 }); }
    expect((hour(s) - 8) * 60).toBeLessThanOrEqual(3 * MESSAGE_MINUTES_BAND.max + 1e-6);
  });

  it("the cost is a function of message count only: same count => same elapsed time whatever the labels", () => {
    const run = (label: boolean): number => {
      const s = day();
      for (let i = 0; i < 20; i++) s.advanceClockPerConversation(label ? { kind: i % 2 ? "summit" : "passing" } : undefined);
      return hour(s);
    };
    expect(run(true)).toBeCloseTo(run(false), 9);
  });

  it("a due event comes due MID-conversation at its hour (no conversation end needed) and never early", () => {
    const s = day();
    s.setPerConversationClockEnabled(true);
    const live = (): ReturnType<GameSessionAdapter["snapshot"]>["live"] => s.snapshot().live;
    for (let i = 0; i < 47; i++) s.advanceClockPerConversation();   // one unbroken conversation, 47 messages
    expect(milestoneDue(live())).toBe(false);                        // "not yet": nothing fires early
    s.advanceClockPerConversation();                                  // message 48, same conversation
    expect(milestoneDue(live())).toBe(true);                         // production's call interrupts it
  });
});
