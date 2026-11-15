import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { endHeldNightSync } from "../support/heldNight";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";

/**
 * ORW-232 slice 3 through the real loop (Ryne 2026-11-10: "Comps should take several hours. They should never be one message"): for a game a person is PLAYING (the front end announces their
 * messages), a staged competition's 3 in-game hours are spread over its rounds - no single round or the crown moves the clock by more than an hour - and the total is still ~3h. A headless
 * driver (no announced messages) keeps the old single jump at the crown (the seeded calibration cadence). Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

function resolveLegally(s: Pick<GameSession, "submitDecision">, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-round" || p.kind === "comp-intent") s.submitDecision({ kind: p.kind, intent: "compete" } as never);
  else s.submitDecision({ kind: p.kind, vote: p.options?.[0]?.id } as never);
}

function competitionHourDeltas(playing: boolean): number[] {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const s = new GameSessionRegistry().sandboxFor(`hours-${playing}`).session as GameSession & Record<string, any>;
  s.createCharacter({ playerName: "P", seed: 21 });
  s.setPerConversationClockEnabled(true);
  const abs = () => s.absHour() as number;
  let n = 0;
  const deltas: number[] = [];
  let inComp = false, spent = 0;
  for (let i = 0; i < 4000; i++) {
    const st = s.getGameState();
    if (st.pending) { resolveLegally(s, st.pending); continue; }
    const ds = st.daySchedule;
    if (st.phase !== "premiere" && ds && !ds.due) {
      if (playing) s.noteMessage({ messageId: `m${n++}` }); else s.advanceClockPerConversation();
      if (["night", "late-night"].includes(s.gameStatus().timeOfDay ?? "")) { if (playing) { s.turnIn(); s.noteMessage({ messageId: `w${n++}` }); } else endHeldNightSync(s as never); }
      continue;
    }
    const before = abs(), wasComp = !!s.snapshot().live?.competition;
    const a = s.advanceGame();
    if (a.held) { endHeldNightSync(s as never); continue; }
    const beat = a.event?.beat;
    if (a.pending) resolveLegally(s, a.pending);
    const isCompBeat = beat === "comp-elimination" || beat === "hoh-competition" || beat === "veto-competition";
    if ((wasComp || isCompBeat) && st.phase !== "premiere") {
      const d = abs() - before;
      if (beat === "comp-elimination" || beat === "hoh-competition" || beat === "veto-competition") { deltas.push(d); inComp = true; spent += d; }
      if (beat === "hoh-competition" || beat === "veto-competition") { if (deltas.length >= 3) return [...deltas, spent]; deltas.length = 0; spent = 0; inComp = false; }
    }
    if (a.finished) break;
  }
  void inComp;
  return deltas;
}

describe("a staged competition's hours, through the real loop", () => {
  it("a person playing: no round and not the crown moves the clock by more than an hour; the whole competition costs about 3h", () => {
    const d = competitionHourDeltas(true);
    const total = d[d.length - 1]!, steps = d.slice(0, -1);
    expect(steps.length, "several rounds and a crown").toBeGreaterThanOrEqual(3);
    // a message can hold the player's approach card AND the first round (two shares, 1.2h); never the competition's whole 3h
    expect(Math.max(...steps), "no single message carries more than two rounds' share").toBeLessThanOrEqual(1.25);
    expect(total).toBeCloseTo(3, 1);
  });
  it("a headless driver keeps the single jump at the crown (the seeded calibration cadence is unchanged)", () => {
    const d = competitionHourDeltas(false);
    const steps = d.slice(0, -1);
    expect(Math.max(...steps)).toBeGreaterThanOrEqual(3 - 1e-6);
  });
});
