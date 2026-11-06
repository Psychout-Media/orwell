import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { resolvePending } from "../../features/support/answerPending";
import { crossToNextDay, newLiveSeason } from "../../src/engine/liveSeason";
import { WAKE_HOUR } from "../../src/engine/timeOfDay";
import { npc } from "../../src/domain/ids";

/**
 * A69 - real day accounting. `dayNumber` follows EVERY roll to a new morning (the schedule's cross-to-next-day and the per-beat wrap), not only the player's turn-in, and the turn-in does not bump it twice.
 * The clock label carries the day again ("8:00am, Day 2"). Failing-first: before the fix, week 1 read "Day 1" at four different 8:00ams and `absHour` ran backwards. Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(false));
type Priv = { absHour(): number; snapshot(): { live: { dayNumber?: number; nightDepth?: number } } };

function walkWeekOne() {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const s = new GameSessionRegistry().sandboxFor(`da-${Math.random()}`).session as GameSessionAdapter;
  s.createCharacter({ playerName: "P", seed: 7 });
  s.setPerConversationClockEnabled(true);
  const p = s as unknown as Priv;
  const live = () => p.snapshot().live;
  for (let i = 0; i < 80 && live().nightDepth === undefined; i++) s.advanceGame();
  s.advanceGame(); // ORW-116 (a): the premiere exit starts the first NIGHT (20:00); this advance crosses it to the first morning (8am)
  const trace: Array<{ day: number; hour: number; abs: number; label?: string }> = [];
  const note = () => trace.push({ day: live().dayNumber ?? 1, hour: live().nightDepth!, abs: p.absHour(), label: (s.getGameState() as { clockLabel?: string }).clockLabel });
  note();
  let rolls = 0, last = live().nightDepth!;
  for (let step = 0; step < 500 && rolls < 3; step++) {
    const st = s.getGameState() as { daySchedule?: { due: boolean } };
    if (st.daySchedule?.due) { const v = s.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req)); }
    else s.advanceClockPerConversation();
    note();
    const h = live().nightDepth!;
    if (h < last - 1) rolls++;
    last = h;
  }
  return { s, trace, rolls };
}

describe("A69 - day accounting", () => {
  it("week 1: the day number rises at every roll to a new morning, never falls, and absHour never goes backwards", () => {
    const { trace, rolls } = walkWeekOne();
    expect(rolls).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < trace.length; i++) {
      expect(trace[i]!.day, `day fell at step ${i}`).toBeGreaterThanOrEqual(trace[i - 1]!.day);
      expect(trace[i]!.abs, `absHour ran backwards at step ${i}: ${trace[i - 1]!.abs} -> ${trace[i]!.abs}`).toBeGreaterThanOrEqual(trace[i - 1]!.abs - 1e-9);
      if (trace[i]!.hour < trace[i - 1]!.hour - 1) expect(trace[i]!.day, `a roll to a new morning must be a new day (step ${i})`).toBe(trace[i - 1]!.day + 1);
    }
    expect(trace[trace.length - 1]!.day).toBeGreaterThanOrEqual(4);
  });
  it("the clock label carries the engine's day again and it matches dayNumber", () => {
    const { trace } = walkWeekOne();
    for (const t of trace) {
      expect(t.label, "label present while the clock runs").toBeDefined();
      expect(t.label).toMatch(new RegExp(`, Day ${t.day}$`));
    }
  });
  it("crossToNextDay: a real night crossed bumps the day once; an already-fresh morning (just turned in) does not", () => {
    const s = newLiveSeason([npc(1), npc(2)]);
    s.nightDepth = 15; s.timeOfDay = "afternoon" as never; s.dayNumber = 1;
    crossToNextDay(s);
    expect(s.dayNumber).toBe(2);
    expect(s.nightDepth).toBe(WAKE_HOUR);
    crossToNextDay(s); // already the fresh morning: the same morning, not a second night
    expect(s.dayNumber).toBe(2);
  });
  it("the player's turn-in moves the day by exactly one (the recap bump is not doubled by the roll accounting)", () => {
    const { s } = walkWeekOne();
    const p = s as unknown as Priv;
    const before = p.snapshot().live.dayNumber ?? 1;
    s.turnIn();
    expect((p.snapshot().live.dayNumber ?? 1) - before).toBe(1);
  });
});
