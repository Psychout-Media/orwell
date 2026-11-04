import { MINUTES_PER_MESSAGE } from "../../src/engine/sleepConstants";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/**
 * The player LINGERS — one long scene of social play (ADR 0003: lingering is play). Ceremonies alone no longer
 * carry the house into the night: the night-gate day-breaks roll the clock to the next morning, and an eviction
 * night costs ~2h in total (PO ruling 2026-11-01). Tests that need the night spend the evening the way play
 * does — via the per-conversation clock, which never wraps past the night.
 *
 * Only the linger moves time: the per-conversation clock is switched on for this one scene and then RESTORED to
 * whatever the scenario had (it is live exactly when its flag is on, since we only linger once the day has
 * started), so later off-screen ticks behave as the scenario configured them.
 */
export function linger(s: GameSessionAdapter): void {
  const was = s.perConversationClockLive();
  s.setPerConversationClockEnabled(true);
  // P4c: the clock ticks a few minutes per message (MINUTES_PER_MESSAGE), so a long scene is ~4 in-game hours of messages (it never wraps the night).
  for (let i = 0; i < Math.round((4 * 60) / MINUTES_PER_MESSAGE); i++) s.advanceClockPerConversation();
  s.setPerConversationClockEnabled(was);
}
