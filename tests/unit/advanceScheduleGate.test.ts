import { toDayTwoMorning } from "../support/dayTwoMorning";
import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";

/** A65 - defense in depth: the ENGINE's advanceGame refuses an ordinary beat before the next milestone is due (ORWELL_ADVANCE_GATE, default OFF). Roles only. */
function runningDay(gate: boolean) {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const s = new GameSessionRegistry().sandboxFor(`gate-${gate}-${Math.random()}`).session as GameSessionAdapter;
  s.createCharacter({ playerName: "P", seed: 7 });
  s.setPerConversationClockEnabled(true);
  const live = () => s.snapshot().live as unknown as { timeOfDay?: string; pending?: unknown };
  toDayTwoMorning(s); // ORW-116: Day 2, 8am (no phase advance moves the clock)
  s.setAdvanceGateEnabled(gate); // (set after the setup advances: an ON gate would hold them)
  expect(live().timeOfDay, "precondition: the day is running").toBeDefined();
  return s;
}
const sched = (s: GameSessionAdapter) => (s.getGameState() as { daySchedule?: { due: boolean; next: string; minutesUntil: number }; beatSeq: number; phase: string }).daySchedule!;
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(false));

describe("A65 - the engine schedule gate", () => {
  it("OFF (default): an explicit advance at 8am stages the competition early - today's behavior, pinned", () => {
    const s = runningDay(false);
    expect(sched(s).due).toBe(false);
    const v = s.advanceGame();
    expect(v.held).toBeUndefined();
    expect(v.pending?.kind ?? v.event?.beat, "the beat ran").toBeTruthy();
  });
  it("ON: before the milestone is due the advance is HELD - typed, nothing committed, beatSeq and board unchanged, not cached", () => {
    const s = runningDay(true);
    const before = s.getGameState() as { beatSeq: number; phase: string };
    const v = s.advanceGame({ idempotencyKey: "k1" });
    expect(v.held).toEqual({ next: sched(s).next, minutesUntil: sched(s).minutesUntil });
    expect(v.event).toBeNull();
    expect(v.pending).toBeNull();
    const after = s.getGameState() as { beatSeq: number; phase: string };
    expect(after.beatSeq).toBe(before.beatSeq);
    expect(after.phase).toBe(before.phase);
    s.advanceGame(); s.advanceGame(); s.advanceGame(); // ordinary advances
    expect(s.getGameState().beatSeq).toBe(before.beatSeq);
  });
  it("ON: once the milestone is due the same advance goes through", () => {
    const s = runningDay(true);
    for (let i = 0; i < 60 && !sched(s).due; i++) s.advanceClockPerConversation();
    expect(sched(s).due).toBe(true);
    const v = s.advanceGame();
    expect(v.held).toBeUndefined();
    expect(v.pending?.kind ?? v.event?.beat).toBeTruthy();
  });
  it("ON: the engine's own fast-forward (admin advanceToFinale) is not stalled by the gate", () => {
    const s = runningDay(true);
    const r = s.advanceToFinale();
    expect(r.finished).toBe(true);
  });
});
