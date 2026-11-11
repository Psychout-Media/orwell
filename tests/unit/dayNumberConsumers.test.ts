import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { resolvePending } from "../../features/support/answerPending";

/**
 * ORW-95 (A70): every consumer of `dayNumber` follows the A69 day fix (#2188: dayNumber rises at every roll to a new morning).
 * absHour and the clock label are pinned in dayAccounting.test.ts; this file pins the other two: the recap / 0122 confessional-sweep
 * key (one per closed day, consecutive) and the hang-out "pulled once per in-game day" cap. No model, roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(false));
type Live = { dayNumber?: number; nightDepth?: number; hangOutPulledDay?: number; hoh?: string };
type Priv = { lastConfessionalSweepDay: number };
const liveOf = (s: GameSessionAdapter): Live => (s.snapshot() as unknown as { live: Live }).live;

function started(seed: number, user: string): GameSessionAdapter {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const s = new GameSessionRegistry().sandboxFor(user).session as GameSessionAdapter;
  s.createCharacter({ playerName: "P", seed });
  s.setPerConversationClockEnabled(true);
  return s;
}

describe("ORW-95 - recap + 0122 sweep key follow the day", () => {
  it("each turn-in closes the current day: the recap is for that day, the sweep key equals it, and consecutive days close consecutively", () => {
    const s = started(7, "orw95-sweep");
    s.setConfessionalDepthEnabled(true);
    const p = s as unknown as Priv;
    for (let i = 0; i < 80 && liveOf(s).nightDepth === undefined; i++) s.advanceGame();
    s.advanceGame();
    const closed: Array<{ before: number; recap?: number; sweep: number; after: number }> = [];
    for (let step = 0; step < 1500 && closed.length < 3; step++) {
      const st = s.getGameState() as { daySchedule?: { due: boolean }; timeOfDay?: string };
      if (st.daySchedule?.due) { const v = s.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req)); }
      else {
        const before = liveOf(s).dayNumber ?? 1;
        const v = s.turnIn({});
        if ((v as { held?: unknown }).held) s.advanceClockPerConversation();
        else closed.push({ before, recap: v.dailyRecap?.day, sweep: p.lastConfessionalSweepDay, after: liveOf(s).dayNumber ?? 1 });
      }
    }
    expect(closed.length).toBe(3);
    for (let i = 0; i < closed.length; i++) {
      const c = closed[i]!;
      expect(c.recap, `recap day (turn-in ${i})`).toBe(c.before);
      expect(c.sweep, `sweep key (turn-in ${i})`).toBe(c.before);
      expect(c.after, `day after turn-in (${i})`).toBe(c.before + 1);
      if (i > 0) expect(c.before, "a new day each close").toBeGreaterThan(closed[i - 1]!.before);
    }
  });
});

describe("ORW-95 - the hang-out 'pulled' cap is per in-game day", () => {
  function parkedOnDayTwo(seed: number): GameSessionAdapter | null {
    const s = started(seed, `orw95-ho${seed}`);
    s.setHangOutEnabled(true);
    for (let i = 0; i < 600; i++) {
      const v = s.advanceGame();
      if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
      const st = s.getGameState() as { daySchedule?: { due: boolean }; pending?: unknown };
      if (st.daySchedule && st.daySchedule.due === false && (liveOf(s).dayNumber ?? 1) >= 2 && !st.pending && liveOf(s).hoh !== undefined) return s;
    }
    return null;
  }
  function withPulledDay(s: GameSessionAdapter, d: number | undefined): void {
    const snap = s.snapshot() as unknown as { live: Live };
    snap.live.hangOutPulledDay = d;
    s.restore(snap as never);
  }
  it("already pulled today (same dayNumber) => never pulled again; pulled on an earlier day => can pull, and records TODAY's dayNumber", () => {
    let sawPull = false, tried = 0;
    for (let seed = 1; seed <= 40 && tried < 12; seed++) {
      const s = parkedOnDayTwo(seed); if (!s) continue; tried++;
      const day = liveOf(s).dayNumber!;
      expect(day).toBeGreaterThanOrEqual(2);
      const snap = s.snapshot();
      withPulledDay(s, day);
      for (let i = 0; i < 20; i++) expect(s.hangOut().stopReason, `seed ${seed}: pulled again on the same day`).not.toBe("pulled");
      s.restore(snap);
      withPulledDay(s, day - 1);
      for (let i = 0; i < 30 && !sawPull; i++) {
        if (s.hangOut().stopReason === "pulled") { sawPull = true; expect(liveOf(s).hangOutPulledDay).toBe(day); }
      }
    }
    expect(tried).toBeGreaterThan(0);
    expect(sawPull, "an earlier day's pull must not block today's").toBe(true);
  });
});
