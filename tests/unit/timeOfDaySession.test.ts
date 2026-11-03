import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";

/**
 * ADR 0006 — the in-game clock + sleep, end to end through the live adapter. Roles only. The feature
 * is OPT-IN (`ORWELL_TIME_OF_DAY`); these tests turn it on, and one asserts it stays DORMANT (the
 * projection carries nothing) when off — the guarantee that keeps the seeded calibration spine unmoved.
 */
const PHASES = ["morning", "afternoon", "evening", "night", "late-night"];
const REST = ["rested", "tired", "running on empty"];

afterEach(() => { delete process.env.ORWELL_TIME_OF_DAY; });

/** Resolve the adapter's pending decision legally (drives the live loop forward). */
function resolveLegally(s: Pick<GameSession, "submitDecision">, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
  else if (p.kind === "houseguests-choice") s.submitDecision({ kind: "houseguests-choice", vote: p.options[0]!.id });
  else if (p.kind === "goodbye-message") s.submitDecision({ kind: "goodbye-message", vote: p.options[0]!.id });
  else if (p.kind === "finale-statement") s.submitDecision({ kind: "finale-statement", statement: "x" });
  else if (p.kind === "finale-answer") s.submitDecision({ kind: "finale-answer", appeal: p.appeals![0]! });
  else if (p.kind === "juror-vote") s.submitDecision({ kind: "juror-vote", vote: p.options[0]!.id });
  else s.submitDecision({ kind: p.kind, vote: p.options[0]!.id });
}

function started(seed = 7): GameSessionAdapter {
  const s = new GameSessionAdapter();
  s.createCharacter({ playerName: "The Player", seed });
  // 0111: close the premiere champagne circle so the session is in free-roam premiere — these tests
  // drive the weekly loop / clock, not the opening toast, so the first advance below is a real beat.
  s.advanceGame();
  return s;
}

describe("ADR 0006 — the clock runs and is surfaced (opt-in)", () => {
  it("surfaces a valid, advancing time-of-day in the Vault-free status + state views", () => {
    process.env.ORWELL_TIME_OF_DAY = "1";
    const s = started();
    const seen = new Set<string>();
    for (let i = 0; i < 16; i++) {
      const adv = s.advanceGame();
      const tod = s.gameStatus().timeOfDay;
      expect(tod).toBeDefined();
      expect(PHASES).toContain(tod);
      seen.add(tod!);
      if (adv.pending) resolveLegally(s, adv.pending);
      if (adv.finished) break;
    }
    // The clock MOVES (not pinned to a single phase) and the state view agrees with the status read.
    expect(seen.size).toBeGreaterThan(1);
    expect(s.getGameState().timeOfDay).toBe(s.gameStatus().timeOfDay);
  });

  it("surfaces the player's OWN qualitative rest cue — and never auto-sleeps them", () => {
    process.env.ORWELL_TIME_OF_DAY = "1";
    const s = started();
    for (let i = 0; i < 4; i++) { const a = s.advanceGame(); if (a.pending) resolveLegally(s, a.pending); }
    const rest = s.getGameState().player?.restStatus;
    expect(rest).toBeDefined();
    expect(REST).toContain(rest);
  });

  it("#537 — a staged competition does NOT advance the clock through a whole day", () => {
    process.env.ORWELL_TIME_OF_DAY = "1";
    const s = started();
    // Walk the first HOH competition to its crown. It is STAGED: it pauses for the player's per-round
    // approach and emits inert `comp-elimination` reveals. NONE of those presentation steps may advance
    // the clock — only the substantive crown beat does. Capture the time-of-day across the whole comp.
    const phases = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const adv = s.advanceGame();
      phases.add(s.gameStatus().timeOfDay!);
      if (adv.pending) resolveLegally(s, adv.pending);
      // Stop once the HOH is crowned (the comp resolved) — we only care about the comp itself.
      if (adv.event?.beat === "hoh-competition") break;
      if (adv.finished) break;
    }
    // Pre-fix, the per-round pauses cycled morning→afternoon→evening→night→late-night within this ONE
    // competition (a whole day spent crowning one HOH). The clock now ticks on substantive play only, so
    // a single competition occupies at most a couple of phases — never a full day's worth of them.
    expect(phases.size).toBeLessThanOrEqual(2);
    expect(phases.has("morning")).toBe(true); // the comp ran on the day it began, not a wrapped one
  });

  it("the bedtime lever turns the player in: it rolls to the next morning and reads rested", () => {
    process.env.ORWELL_TIME_OF_DAY = "1";
    const s = started();
    s.advanceGame(); // start the clock
    const v = s.turnIn();
    expect(v).toBeDefined();
    expect(s.gameStatus().timeOfDay).toBe("morning"); // a fresh day
    expect(s.getGameState().player?.restStatus).toBe("rested"); // an early night ⇒ sharp tomorrow
  });
});

describe("ADR 0006 — the Vault Wall holds: NPC sleep never leaks", () => {
  it("no houseguest card or projection exposes any NPC rest/sleep/bedtime value", () => {
    process.env.ORWELL_TIME_OF_DAY = "1";
    const s = started();
    for (let i = 0; i < 6; i++) { const a = s.advanceGame(); if (a.pending) resolveLegally(s, a.pending); }
    const view = s.getGameState();
    // The player's OWN cue is allowed; no NPC card carries one, and no engine-only sleep field serializes out.
    expect(view.house.every((c) => !("restStatus" in c))).toBe(true);
    const houseJson = JSON.stringify(view.house);
    for (const banned of ["restStatus", "bedtime", "asleep", "lastSleepPhase", "restPenalty", "playerRetired"]) {
      expect(houseJson).not.toContain(banned);
    }
    // engine-only sleep bookkeeping never rides the player projection either
    const viewJson = JSON.stringify(view);
    for (const banned of ["lastSleepPhase", "playerRetired", "restPenalty"]) {
      expect(viewJson).not.toContain(banned);
    }
  });
});

describe("ADR 0006 — dormant by default (the calibration-safe guarantee)", () => {
  it("carries no time-of-day or rest cue when the feature is off", () => {
    process.env.ORWELL_TIME_OF_DAY = "0"; // explicit OFF (default flip 2026-11-03)
    const s = started();
    for (let i = 0; i < 6; i++) { const a = s.advanceGame(); if (a.pending) resolveLegally(s, a.pending); }
    expect(s.gameStatus().timeOfDay).toBeUndefined();
    expect(s.getGameState().timeOfDay).toBeUndefined();
    expect(s.getGameState().player?.restStatus).toBeUndefined();
    // the bedtime lever is inert when the clock isn't running
    s.turnIn();
    expect(s.gameStatus().timeOfDay).toBeUndefined();
  });
});
