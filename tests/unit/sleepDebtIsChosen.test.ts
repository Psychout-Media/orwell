import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { advanceClock, advanceClockPerMessage, playerTurnIn, playerRestDeficit } from "../../src/engine/liveSeason";
import type { LiveSeasonState } from "../../src/engine/liveSeason";
import { PLAYER } from "../../src/domain/ids";

/**
 * ORW-322 (Coordinator ruling on #2574): sleep debt comes only from the player's CHOICE to stay up. Ceremony-beat hours are presentation (felt durations differ from the flat default), so a beat that carries the
 * clock across the 8am edge with nobody having lingered into the night banks nothing; a night of conversation ticks does. Roles only.
 */
function liveAt(hour: number): LiveSeasonState {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const s = new GameSessionRegistry().sandboxFor(`sdc-${hour}-${Math.random()}`).session as unknown as { createCharacter(r: unknown): unknown; live: LiveSeasonState; advanceGame(): unknown };
  s.createCharacter({ playerName: "P", seed: 3 });
  s.advanceGame(); // starts the day (the clock initializes on the first ceremony beat)
  const live = s.live;
  live.nightDepth = hour;
  live.lastSleepDepth = undefined;
  live.nightTurns = undefined;
  return live;
}

describe("sleep debt is banked only when the player chose to stay up", () => {
  it("a ceremony beat that carries the clock over the 8am edge, with no night conversation, banks no debt", () => {
    const live = liveAt(30);
    advanceClock(live, 3); // the per-beat path: wraps to the next morning
    expect(live.lastSleepDepth).toBeUndefined();
    expect(playerRestDeficit(live)).toBe(0);
    GameSessionAdapter.setTimeOfDayEnabled(null);
  });
  it("the same wrap after the player lingered into the night (conversation ticks from 8pm) banks the full debt", () => {
    const live = liveAt(21);
    for (let i = 0; i < 3; i++) advanceClockPerMessage(live, 5 / 60);   // three messages in the night band
    expect(live.nightTurns).toBe(3);
    live.nightDepth = 30;
    advanceClock(live, 3);
    expect(live.lastSleepDepth).toBe(32);
    expect(playerRestDeficit(live)).toBe(1);
    expect(live.nightTurns).toBeUndefined();                              // a new night counts from zero
    GameSessionAdapter.setTimeOfDayEnabled(null);
  });
  it("messages before 8pm do not count as staying up", () => {
    const live = liveAt(14);
    for (let i = 0; i < 5; i++) advanceClockPerMessage(live, 5 / 60);
    expect(live.nightTurns).toBeUndefined();
    live.nightDepth = 30;
    advanceClock(live, 3);
    expect(live.lastSleepDepth).toBeUndefined();
    GameSessionAdapter.setTimeOfDayEnabled(null);
  });
  it("the player's own turnIn sets the debt from the chosen bed hour and clears the counter", () => {
    const live = liveAt(26);
    live.nightTurns = 4;
    playerTurnIn(live, PLAYER);
    expect(live.lastSleepDepth).toBe(26);
    expect(live.nightTurns).toBeUndefined();
    GameSessionAdapter.setTimeOfDayEnabled(null);
  });
});
