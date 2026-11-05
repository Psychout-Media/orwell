import { describe, it, expect, afterEach, vi } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { eventBeatHours, type LiveSeasonState } from "../../src/engine/liveSeason";
import { eventSpanHours } from "../../src/engine/timeOfDay";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";

/**
 * PO ruling 2026-11-01 — "eviction night and the finale take about two in-game hours, total". Each
 * presentation step of those events (a reveal batch, a goodbye, a Q&A, a jury-vote reveal) used to charge
 * the flat +3h per beat, so one eviction night ran most of a day and the finale ran for days. Now the
 * event's budget is charged ONCE (its first step) and every later step costs nothing. Roles only.
 */

afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

const BUDGET = eventSpanHours("eviction");

describe("eventBeatHours — one budget per event, however many steps", () => {
  it("charges the eviction budget on the first step and nothing after, per week", () => {
    const s = {} as LiveSeasonState;
    expect(eventBeatHours(s, "eviction-reveal", 3, BUDGET)).toBe(BUDGET);
    expect(eventBeatHours(s, "eviction-reveal", 3, BUDGET)).toBe(0);
    expect(eventBeatHours(s, "eviction", 3, BUDGET)).toBe(0);
    expect(eventBeatHours(s, "eviction-goodbye", 3, BUDGET)).toBe(0);
    expect(eventBeatHours(s, "eviction-result", 3, BUDGET)).toBe(0);
    // next week's eviction night is a new event with a fresh budget
    expect(eventBeatHours(s, "eviction-reveal", 4, BUDGET)).toBe(BUDGET);
  });

  it("treats the whole finale as one event and leaves other beats alone", () => {
    const s = {} as LiveSeasonState;
    expect(eventBeatHours(s, "finale", 9, BUDGET)).toBe(BUDGET);
    expect(eventBeatHours(s, "finale", 9, BUDGET)).toBe(0);
    expect(eventBeatHours(s, "finale-reveal", 9, BUDGET)).toBe(0);
    expect(eventBeatHours(s, "finale-result", 9, BUDGET)).toBe(0);
    expect(eventBeatHours(s, "hoh-competition", 9, BUDGET)).toBeNull();
    expect(eventBeatHours(s, "nominations", 9, BUDGET)).toBeNull();
  });
});

function resolveLegally(s: Pick<GameSession, "submitDecision">, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
  else if (p.kind === "comp-intent") s.submitDecision({ kind: "comp-intent", intent: "compete" });
  else if (p.kind === "goodbye-message") s.submitDecision({ kind: "goodbye-message", statement: "bye", vote: p.options[0]?.id });
  else if (p.kind === "finale-statement") s.submitDecision({ kind: "finale-statement", statement: "x" });
  else if (p.kind === "finale-answer") s.submitDecision({ kind: "finale-answer", appeal: p.appeals![0]! });
  else if (p.kind === "exit-interview") s.submitDecision({ kind: "exit-interview", vote: p.options?.[0]?.id ?? "gracious" });
  else s.submitDecision({ kind: p.kind, vote: p.options?.[0]?.id } as never);
}

const EVICTION = new Set(["eviction", "eviction-reveal", "eviction-goodbye", "eviction-result", "final-eviction"]);
const FINALE = new Set(["finale", "finale-reveal", "finale-result"]);

describe("a real season — eviction nights and the finale each move the clock once", () => {
  it("never charges the clock on more than one step of any eviction night or the finale", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("event-clock");
    const s = sb.session as GameSession & { snapshot(): { live?: LiveSeasonState } };
    s.createCharacter({ playerName: "The Player", seed: 108 });

    const moves = new Map<string, number>(); // event key → steps that moved the clock
    let evictionNights = 0;
    let finaleSteps = 0;
    for (let i = 0; i < 4000; i++) {
      const before = s.snapshot().live;
      const depthBefore = before?.nightDepth;
      const weekBefore = before?.week ?? 0;
      const v = s.advanceGame();
      const beat = v.event?.beat;
      const after = s.snapshot().live;
      if (beat && (EVICTION.has(beat) || FINALE.has(beat)) && depthBefore !== undefined) {
        const key = FINALE.has(beat) ? "finale" : `eviction:w${weekBefore}`;
        if (FINALE.has(beat)) finaleSteps++;
        if (beat === "eviction-result") evictionNights++;
        if (after?.nightDepth !== depthBefore) moves.set(key, (moves.get(key) ?? 0) + 1);
      }
      if (v.pending) resolveLegally(s, v.pending);
      if (v.finished) break;
    }
    expect(evictionNights).toBeGreaterThan(3);
    expect(finaleSteps).toBeGreaterThan(3); // the finale really is many steps…
    expect(moves.size).toBeGreaterThan(3);
    for (const [key, n] of moves) expect(n, `${key} moved the clock on ${n} steps`).toBe(1); // …but costs once
  });
});

describe("an eviction night costs exactly its 2 in-game hours, once (not twice)", () => {
  it("the clock moves by exactly eventSpanHours('eviction') across each whole eviction night", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("event-clock-hours");
    const s = sb.session as GameSession & { snapshot(): { live?: LiveSeasonState } };
    s.createCharacter({ playerName: "The Player", seed: 108 });
    expect(eventSpanHours("eviction")).toBe(2); // the constants say 2 hours (EVENT_DURATION.hoursByBeat.eviction)

    const hoursByNight = new Map<string, number>(); // eviction night → total clock hours charged across ALL its steps
    for (let i = 0; i < 4000; i++) {
      const before = s.snapshot().live;
      const depthBefore = before?.nightDepth;
      const weekBefore = before?.week ?? 0;
      const v = s.advanceGame();
      const beat = v.event?.beat;
      const after = s.snapshot().live;
      if (beat && beat !== "final-eviction" && EVICTION.has(beat) && depthBefore !== undefined && after?.nightDepth !== undefined) {
        let d = after.nightDepth - depthBefore;
        if (d < 0) d += 24; // the 8am wrap
        const key = `eviction:w${weekBefore}`;
        hoursByNight.set(key, (hoursByNight.get(key) ?? 0) + d);
      }
      if (v.pending) resolveLegally(s, v.pending);
      if (v.finished) break;
    }
    expect(hoursByNight.size).toBeGreaterThan(3);
    for (const [key, h] of hoursByNight) expect(h, `${key} charged ${h}h`).toBeCloseTo(eventSpanHours("eviction"), 6);
  });
});

describe("a night is counted once, even when an event's later steps sit at 8am", () => {
  it("an eviction night that rolls past 8am accrues the night's fatigue exactly once", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const accrue = vi.spyOn(GameSessionAdapter.prototype as never, "accrueNightFatigue" as never);
    try {
      const reg = new GameSessionRegistry();
      const sb = reg.sandboxFor("night-once");
      const s = sb.session as unknown as GameSession & { live: LiveSeasonState };
      s.createCharacter({ playerName: "The Player", seed: 108 });
      // Play to the eviction night (the board is on the eviction beat, before any reveal).
      // (the night-gate day-break lands the board on the eviction beat at the next morning)
      for (let i = 0; i < 400; i++) {
        const v = s.advanceGame();
        if (v.pending) resolveLegally(s, v.pending);
        if (v.event?.beat === "day-break" && s.live.beat === "eviction" && !s.live.eviction && !s.live.pending) break;
      }
      expect(s.live.beat).toBe("eviction");
      // The house stayed up very late: the eviction's first step crosses the 8am wake.
      s.live.nightDepth = 31.5;
      const before = accrue.mock.calls.length;
      for (let i = 0; i < 60; i++) {
        const v = s.advanceGame();
        if (v.pending) resolveLegally(s, v.pending);
        if (v.event?.beat === "eviction-result") break;
      }
      expect(accrue.mock.calls.length - before, "one night, one accrual").toBe(1);
    } finally {
      accrue.mockRestore();
    }
  });
});
