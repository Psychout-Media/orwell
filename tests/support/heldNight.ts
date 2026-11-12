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
    // ORW-97 (the schedule gate, default ON): time passes in ONE batch to the moment the engine itself names - the bedtime hold's `minutesUntil` (evening and later) or the next event's `minutesUntil` (daytime:
    // the hold means "not due yet", NOT "go to bed", which burned a whole in-game day per event). Polling status + turnIn + state after every 5-minute tick made a long driver (the jury scenario) take minutes.
    let ticks = 1;
    if (tod === "evening" || tod === "night" || tod === "late-night") {
      const r = (await call("turnIn", {})) as { held?: { minutesUntil?: number } } | null;
      if (!r?.held) return; // ORW-258: a person playing may not go to bed before the night period (the gate answers `held`): keep letting time pass
      ticks = Math.max(1, Math.ceil((r.held.minutesUntil ?? 0) / 5));
    } else if (i > 0) { // i > 0: the hold was just reported by the caller, so the first pass only ticks
      const gs = (await call("getGameState", {})) as { daySchedule?: { due?: boolean; minutesUntil?: number } } | null;
      if (gs?.daySchedule?.due) return;
      ticks = Math.max(1, Math.ceil((gs?.daySchedule?.minutesUntil ?? 0) / 5));
    }
    for (let k = 0; k < ticks; k++) {
      if (tick) tick(); else await call("noteMessage", { messageId: `${tag}-${i}-${k}-${Math.random().toString(36).slice(2)}` });
    }
  }
  await call("turnIn", {}); // never spin: the bedtime gate (if still refusing) is reported by the caller's own progress check
}

/** The same real route for a driver that holds the session directly: let time pass (cheap in-process clock steps) until it is evening, then turn in. */
export function endHeldNightSync(s: {
  gameStatus(): { timeOfDay?: string };
  getGameState?(): { daySchedule?: { due?: boolean; minutesUntil?: number } };
  advanceClockPerConversation(): void;
  turnIn(): unknown;
  setBedtimeGateEnabled?(on: boolean): void;
}, opts: { direct?: boolean } = {}): void {
  // `direct`: a seeded-determinism test (flag on/off must reach the same season) cannot let wall-of-messages time pass differently per arm; it turns in at once with the narrator-facing bedtime gate off (the night HOLD stays on).
  if (opts.direct) { s.setBedtimeGateEnabled?.(false); s.turnIn(); return; }
  for (let i = 0; i < 800; i++) {
    const tod = s.gameStatus().timeOfDay;
    let ticks = 1; // ORW-97: batch to the moment the engine names (see endHeldNight)
    if (tod === "evening" || tod === "night" || tod === "late-night") {
      const r = s.turnIn() as { held?: { minutesUntil?: number } } | undefined;
      if (!r?.held) return; // ORW-258: a person playing may not go to bed before the night period (the gate answers `held`): keep letting time pass
      ticks = Math.max(1, Math.ceil((r.held.minutesUntil ?? 0) / 5));
    } else if (i > 0 && s.getGameState) {
      const ds = s.getGameState().daySchedule;
      if (ds?.due) return;
      ticks = Math.max(1, Math.ceil((ds?.minutesUntil ?? 0) / 5));
    }
    for (let k = 0; k < ticks; k++) s.advanceClockPerConversation();
  }
  s.turnIn();
}
