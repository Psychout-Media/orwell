import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { resolvePending } from "./answerPending";

/**
 * Play a live session forward (answering every pending decision through the shared driver) and return a compact trail
 * of each beat's week / HOH / nominees plus the final eviction order: the seeded outcomes, as one comparable string.
 * Used by the "this feature leaves the seeded outcomes untouched" scenarios. `afterBeat` lets a caller run the
 * orchestrator's off-screen tick between beats (a bare session never ticks its off-screen layers by itself).
 */
export function seasonTrail(session: GameSessionAdapter, maxBeats = 120, afterBeat?: () => void): string {
  const trail: string[] = [];
  for (let i = 0; i < maxBeats; i++) {
    const v = session.advanceGame();
    if (v.pending) resolvePending(v.pending, (req) => session.submitDecision(req));
    afterBeat?.(); // e.g. the orchestrator's off-screen tick, so opt-in off-screen layers actually get exercised
    trail.push(`${v.status.week}:${v.status.hoh?.id}:${v.status.nominees.map((n) => n.id).join("+")}`);
    if (v.finished) break;
  }
  return trail.join("|") + JSON.stringify(session.snapshot().live?.evictionOrder);
}
