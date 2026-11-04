import { describe, it, expect } from "vitest";
import { advanceClockPerScene, type LiveSeasonState } from "../../src/engine/liveSeason";
import { SCENE, MESSAGES_PER_MORNING } from "../../src/engine/sleepConstants";
import { WAKE_HOUR } from "../../src/engine/timeOfDay";
import { milestoneDue, nextMilestone } from "../../src/engine/daySchedule";

/**
 * P2b (Ryne 2026-11-04) — PRODUCTION OWNS THE SCHEDULE: the clock, not the player's message count or readiness, brings a scheduled event in. Every ordinary message
 * bills a minimum felt amount (even when its scene has hit the cap), so the clock always reaches the event's hour on its own; the default pace is ~8-12 messages per
 * morning, from ONE tunable constant. Roles only.
 */
const morningOf = (beat: string): LiveSeasonState => ({ nightDepth: WAKE_HOUR, timeOfDay: "morning", beat } as unknown as LiveSeasonState);

describe("the default pace: ~48 ordinary messages per morning (5 in-game minutes each) (one tunable constant)", () => {
  it("MESSAGES_PER_MORNING is derived from the pace and sits in the PO's ~48 band", () => {
    expect(MESSAGES_PER_MORNING).toBeGreaterThanOrEqual(40);
    expect(MESSAGES_PER_MORNING).toBeLessThanOrEqual(56);
  });
  it("a scheduled afternoon event is NOT due after one message fewer, and IS due on the MESSAGES_PER_MORNING-th (same scene, cap or not)", () => {
    const s = morningOf("veto-competition");
    expect(nextMilestone(s)?.phase).toBe("afternoon");
    for (let i = 0; i < MESSAGES_PER_MORNING - 1; i++) advanceClockPerScene(s, "scene:one-room", SCENE.perExchangeHours);
    expect(milestoneDue(s), "one message short of the pace: production says not yet").toBe(false);
    advanceClockPerScene(s, "scene:one-room", SCENE.perExchangeHours);
    expect(milestoneDue(s), "the clock itself brings the event in on the pace-th message").toBe(true);
  });
});

describe("every message bills at least the floor — the clock cannot stall behind a capped scene", () => {
  it("after a scene has accrued its cap, further messages STILL advance the clock by the floor", () => {
    const s = morningOf("hoh-competition");
    for (let i = 0; i < 40; i++) advanceClockPerScene(s, "scene:long", SCENE.perExchangeHours);
    const h = s.nightDepth!;
    advanceClockPerScene(s, "scene:long", SCENE.perExchangeHours);
    expect(s.nightDepth! - h).toBeGreaterThanOrEqual(SCENE.minPerMessageHours - 1e-9);
  });
  it("a PROPOSED long felt duration is still clamped to the scene cap (the floor is a floor, not a loophole)", () => {
    const s = morningOf("hoh-competition");
    advanceClockPerScene(s, "scene:x", 99);
    expect(s.nightDepth! - WAKE_HOUR).toBeCloseTo(SCENE.capHours, 5);
  });
});
