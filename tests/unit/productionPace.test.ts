import { describe, it, expect } from "vitest";
import { advanceClockPerMessage, type LiveSeasonState } from "../../src/engine/liveSeason";
import { MINUTES_PER_MESSAGE, MESSAGES_PER_MORNING } from "../../src/engine/sleepConstants";
import { WAKE_HOUR } from "../../src/engine/timeOfDay";
import { milestoneDue, nextMilestone } from "../../src/engine/daySchedule";

/**
 * P2b/P4c (Ryne 2026-11-04) - PRODUCTION OWNS THE SCHEDULE: the clock, not the player's message count or readiness, brings a scheduled event in. Every ordinary message ticks
 * exactly MINUTES_PER_MESSAGE (5 min) so the clock always reaches the event's hour on its own; the default pace is ~48 messages per 4h morning, from ONE tunable constant. Roles only.
 */
const morningOf = (beat: string): LiveSeasonState => ({ nightDepth: WAKE_HOUR, timeOfDay: "morning", beat } as unknown as LiveSeasonState);
const tick = (s: LiveSeasonState): void => advanceClockPerMessage(s, MINUTES_PER_MESSAGE / 60);

describe("the default pace: 48 ordinary messages per morning (5 in-game minutes each, one tunable constant)", () => {
  it("MESSAGES_PER_MORNING is derived from the pace", () => {
    expect(MESSAGES_PER_MORNING).toBe(48);
  });
  it("a scheduled afternoon event is NOT due after one message fewer, and IS due on the MESSAGES_PER_MORNING-th", () => {
    const s = morningOf("hoh-competition");
    expect(nextMilestone(s)?.phase).toBe("afternoon");
    for (let i = 0; i < MESSAGES_PER_MORNING - 1; i++) tick(s);
    expect(milestoneDue(s), "one message short of the pace: production says not yet").toBe(false);
    tick(s);
    expect(milestoneDue(s), "the clock itself brings the event in on the pace-th message").toBe(true);
  });
});

describe("the clock cannot stall and cannot run away", () => {
  it("every message advances the clock by the pace, however long the conversation has run", () => {
    const s = morningOf("hoh-competition");
    for (let i = 0; i < 40; i++) tick(s);
    const h = s.nightDepth!;
    tick(s);
    expect((s.nightDepth! - h) * 60).toBeCloseTo(MINUTES_PER_MESSAGE, 5);
  });
  it("is a no-op before the day starts and never wraps the night", () => {
    const pre = { beat: "hoh-competition" } as unknown as LiveSeasonState;
    tick(pre);
    expect(pre.nightDepth).toBeUndefined();
    const late = morningOf("hoh-competition"); late.nightDepth = 31.95;
    for (let i = 0; i < 20; i++) tick(late);
    expect(late.nightDepth!).toBeLessThan(32);
  });
});
