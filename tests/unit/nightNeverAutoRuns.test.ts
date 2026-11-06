import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { nightIsOver, nightHeld, nightBreakPending, newLiveSeason, crossToNextDay } from "../../src/engine/liveSeason";

/**
 * ORW-116 (b), Ryne's rule (playtest 2026-11-06): THE NIGHT IS NEVER AUTO-RUN. With the clock live, nothing - a plain advance, an NPC-ceremony
 * pre-resolve, a chained step - may roll the night. People stay social through the evening and night until the PLAYER turns in, or the clock
 * reaches the next 8am (full sleep debt, no forced bedtime). Prod log 21:17:11 "pre-resolve advanced nominations" ran "The house turns in for the
 * night, and a new day dawns..." straight after the HOH win. Roles only.
 */
describe("ORW-116 (b) - the night is never auto-run", () => {
  afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));
  const start = (clock = true) => {
    GameSessionAdapter.setTimeOfDayEnabled(clock);
    const s = new GameSessionRegistry().sandboxFor(`nn-${clock}-${Math.random()}`).session;
    s.createCharacter({ playerName: "P", archetype: "floater", seed: 7 });
    s.setPerConversationClockEnabled(clock);
    s.advanceGame(); // the toast closes
    for (let i = 0; i < 40; i++) s.noteMessage({ messageId: `m${i}` }); // the player socializes into the evening (a player conversation arms the hold)
    s.advanceGame(); // the premiere exit
    return s;
  };

  it("the first night is held: repeated plain advances do not roll it, no beat is committed", () => {
    const s = start();
    const before = s.snapshot().live!;
    expect(before.nightDepth!).toBeGreaterThan(19);
    const seq = s.gameStatus().beatSeq;
    for (let i = 0; i < 5; i++) {
      const v = s.advanceGame();
      expect(v.event ?? null, "no overnight beat before bed or 8am").toBeNull();
      expect(v.held, "a typed hold, not a silent no-op").toBeDefined();
    }
    const after = s.snapshot().live!;
    expect(after.dayNumber ?? 1).toBe(1);
    expect(after.nightDepth).toBe(before.nightDepth);
    expect(s.gameStatus().beatSeq, "a hold commits nothing").toBe(seq);
  });

  it("once the PLAYER turns in, the night is over: the day has rolled, nothing is held, the HOH is next", () => {
    const s = start();
    s.turnIn();
    expect(s.snapshot().live!.dayNumber).toBe(2);
    const v = s.advanceGame();
    expect(v.held ?? null).toBeNull();
    expect(v.pending?.kind).toBe("comp-round"); // the production due-gate (not this hold) keeps it until the afternoon
  });

  it("clock off (the calibration spine): nothing is held - the premiere exit stages the HOH as before", () => {
    const s = start(false);
    const v = s.advanceGame();
    expect(v.held ?? null).toBeNull();
  });

  it("staying up to the next 8am rolls the night WITH full sleep debt (no forced bedtime, but a real cost)", () => {
    const s = newLiveSeason([] as never);
    s.nightDepth = 32 - 0.0001; s.timeOfDay = "late-night" as never;
    crossToNextDay(s);
    expect(s.lastSleepDepth).toBe(32);
    expect(s.nightDepth).toBe(8);
  });

  it("engine rule: the night is over for a retired player or at the next 8am, never before", () => {
    const s = newLiveSeason([] as never);
    s.nightDepth = 20;
    expect(nightIsOver(s)).toBe(false);
    s.playerRetired = true;
    expect(nightIsOver(s)).toBe(true);
    s.playerRetired = false;
    s.nightDepth = 32;
    expect(nightIsOver(s)).toBe(true);
    s.nightDepth = undefined;
    expect(nightIsOver(s)).toBe(true); // no clock => never held
    expect(nightBreakPending(s)).toBe(false);
  });
});
