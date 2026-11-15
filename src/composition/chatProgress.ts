/**
 * ORW-323 - "did the live loop move?" for the orchestrator's off-screen tick decision (pure; no I/O).
 *
 * The orchestrator gives a commit that moved the live loop (a beat: an advance, a resolved decision) an un-debounced, always-ticking off-screen society tick, and a commit that did not
 * (a social / chat commit) a tick debounced to one per SOCIETY_TICK_HOURS of in-game time. To tell them apart it compares the live-loop state before and after the commit. Once the front
 * end announces player messages (`noteMessage`), the announcement itself moves chat-side bookkeeping on nearly EVERY message: the clock (`nightDepth`, `timeOfDay`) and the A8 desire clock
 * (`desireApproachedAt`, the standing `interruption`: a houseguest steps in, the cooldown starts, it clears). None of that is the loop progressing, so it is stripped from the comparison.
 * `nightTurns` (ORW-393) is the per-message night-lingering counter the clock bumps on every night message. Leaving the desire-clock keys in made ~35 of ~36 chat commits a game day read as beat commits (the BDD Auditor's ORW-306 baseline: ~109 scenes a game day in chat play against ~17 advance-only).
 */
export const CHAT_SIDE_LIVE_KEYS = ["nightDepth", "timeOfDay", "interruption", "approachHeld", "desireApproachedAt", "desireRestShift", "approachStreak", "goalApproaches", "pitched", "nightTurns", "napHoursToday", "napWake"] as const; // ORW-393: nightTurns counts every night message (the player lingering), so it is chat-side too
// 0148: a nap moves the clock + the nap credit (`napHoursToday`/`napWake`), none of which is the live loop progressing; the orchestrator lives the slept hours through `consumeNapHours`.

/** A stable string for the live-loop state; in message mode the chat-side keys are left out. */
export function loopFingerprint(live: object | null | undefined, messageMode: boolean): string {
  if (!live || !messageMode) return JSON.stringify(live ?? null);
  const rest: Record<string, unknown> = { ...(live as Record<string, unknown>) };
  for (const k of CHAT_SIDE_LIVE_KEYS) delete rest[k];
  return JSON.stringify(rest);
}
