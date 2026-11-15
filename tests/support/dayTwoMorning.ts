import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/**
 * ORW-116 (Ryne): no phase advance moves the clock, so a fixture that wants "the morning of Day 2, 8am" can no longer get there by plain advances (the
 * premiere night is the player's to spend). This puts a clock-on session there directly: close the toast, then set the day state (a TEST-ONLY seam on the live state, never a game path). Roles only.
 */
export function toDayTwoMorning(s: GameSessionAdapter): void {
  s.advanceGame(); // the champagne-circle close
  const live = (s as unknown as { live: { nightDepth?: number; timeOfDay?: string; dayNumber?: number; firstNightPassed?: boolean; playerRetired?: boolean; wakeHour?: number } }).live;
  live.nightDepth = 8;
  live.timeOfDay = "morning";
  live.dayNumber = 2;
  live.firstNightPassed = true;
  live.playerRetired = false;
  live.wakeHour = undefined;
}
