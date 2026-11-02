import { describe, it, expect, afterEach } from "vitest";
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
