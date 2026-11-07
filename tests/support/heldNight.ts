/**
 * ORW-116 / ORW-236 (Ryne): the night is never auto-run - an advance that would roll it comes back typed `held` until the PLAYER turns in or the clock reaches 8am. A headless
 * driver (calibration sims, the smoke, UAT) is a player who just keeps asking for the next beat, so on a `held` it does what a real player does: lets TIME PASS (messages,
 * 5 in-game minutes each) until it is evening, then turns in (the bedtime gate allows a bed from the evening on). No hold is switched off; the real route is exercised.
 *
 * `tick` (optional) is a cheap in-process clock step (`session.advanceClockPerConversation()`); without it each step is a real `noteMessage` call (HTTP drivers).
 */
export async function endHeldNight(
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  tag: string,
  tick?: () => void,
  opts: { direct?: boolean } = {},
): Promise<void> {
  // `direct`: a driver whose engine runs with the narrator-facing bedtime gate off (the HTTP UAT) turns in the moment the night is held - a real `turnIn`, no clock stepping
  // (stepping 5-minute messages over HTTP, ~50 per held night, would blow the heavy lane's time budget).
  if (opts.direct) { await call("turnIn", {}); return; }
  for (let i = 0; i < 800; i++) {
    const st = (await call("gameStatus", {})) as { timeOfDay?: string } | null;
    const tod = st?.timeOfDay;
    if (tod === "evening" || tod === "night" || tod === "late-night") {
      await call("turnIn", {});
      return;
    }
    if (tick) tick(); else await call("noteMessage", { messageId: `${tag}-${i}-${Math.random().toString(36).slice(2)}` });
  }
  await call("turnIn", {}); // never spin: the bedtime gate (if still refusing) is reported by the caller's own progress check
}

/** The same real route for a driver that holds the session directly: let time pass (cheap in-process clock steps) until it is evening, then turn in. */
export function endHeldNightSync(s: {
  gameStatus(): { timeOfDay?: string };
  advanceClockPerConversation(): void;
  turnIn(): unknown;
  setBedtimeGateEnabled?(on: boolean): void;
}, opts: { direct?: boolean } = {}): void {
  // `direct`: a seeded-determinism test (flag on/off must reach the same season) cannot let wall-of-messages time pass differently per arm; it turns in at once with the narrator-facing bedtime gate off (the night HOLD stays on).
  if (opts.direct) { s.setBedtimeGateEnabled?.(false); s.turnIn(); return; }
  for (let i = 0; i < 800; i++) {
    const tod = s.gameStatus().timeOfDay;
    if (tod === "evening" || tod === "night" || tod === "late-night") break;
    s.advanceClockPerConversation();
  }
  s.turnIn();
}
