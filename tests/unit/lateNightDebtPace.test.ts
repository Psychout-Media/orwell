import { describe, it, expect } from "vitest";
import { advanceClockPerMessage, playerTurnIn, playerRestDeficit, type LiveSeasonState } from "../../src/engine/liveSeason";
import { restDeficitForDepth } from "../../src/engine/timeOfDay";
import { MINUTES_PER_MESSAGE } from "../../src/engine/sleepConstants";

/**
 * P4c + Ryne (2026-11-04): late night (midnight-8am) is intentionally the sleep-debt mechanic. Messages are now cheaper in time (5 min), but the debt is a function of the
 * IN-GAME HOUR the player was last awake to - so chatting midnight -> 2am costs exactly the per-in-game-hour debt it always did (it just takes ~24 messages, not ~5).
 * Turning in still banks it, and the clock still never auto-wraps the night. Roles only.
 */
const at = (hour: number): LiveSeasonState => ({ nightDepth: hour, timeOfDay: "late-night", beat: "hoh-competition", evictionOrder: [] } as unknown as LiveSeasonState);

describe("late-night debt is per in-game hour, independent of the per-message pace", () => {
  it("chatting from midnight to 2am (24 messages) and turning in banks the same debt as being awake to 2am", () => {
    const s = at(24);
    const msgs = (2 * 60) / MINUTES_PER_MESSAGE;
    for (let i = 0; i < msgs; i++) advanceClockPerMessage(s, MINUTES_PER_MESSAGE / 60);
    expect(s.nightDepth).toBeCloseTo(26, 5);
    playerTurnIn(s, "player");
    const direct = at(26); playerTurnIn(direct, "player");
    expect(playerRestDeficit(s)).toBeCloseTo(playerRestDeficit(direct), 6);
    expect(playerRestDeficit(s)).toBeCloseTo(restDeficitForDepth(26), 6);
    expect(playerRestDeficit(s)).toBeGreaterThan(restDeficitForDepth(24));
    expect(s.nightDepth).toBe(8); // turning in still works: the next morning
  });
  it("debt grows with each in-game hour awake, not with the message count (24 vs 12 messages differ by the same hour-based amount)", () => {
    const run = (n: number): number => { const s = at(24); for (let i = 0; i < n; i++) advanceClockPerMessage(s, MINUTES_PER_MESSAGE / 60); playerTurnIn(s, "player"); return playerRestDeficit(s); };
    expect(run(24)).toBeCloseTo(restDeficitForDepth(26), 6);
    expect(run(12)).toBeCloseTo(restDeficitForDepth(25), 6);
    expect(run(24)).toBeGreaterThan(run(12));
  });
  it("never auto-wraps the night (the player owns bedtime)", () => {
    const s = at(31.9);
    for (let i = 0; i < 100; i++) advanceClockPerMessage(s, MINUTES_PER_MESSAGE / 60);
    expect(s.nightDepth).toBeLessThan(32);
  });
});
