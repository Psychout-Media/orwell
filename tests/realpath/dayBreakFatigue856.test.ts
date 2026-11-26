import { describe, it, expect, vi, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { answerPending } from "../../features/support/answerPending";

/**
 * ORW-856: a player who stays up through the night and reaches the day-break wrap pays the night into the multi-night fatigue meter, exactly once per wrap, the same as every other genuine night-end. Played, not set
 * by hand: seed 108 played with a message each turn and every decision answered, the player NEVER turning in; each day-break the game hands them is counted. Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));
type Sess = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function stayUp(flagOn: boolean): { wraps: number; accruals: number; fatigue: number | undefined } {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const s = new GameSessionRegistry().sandboxFor(`dbf-${flagOn}`).session as Sess;
  s.createCharacter({ playerName: "The Player", seed: 108 });
  s.setMultiNightFatigueEnabled(true);
  s.setDayBreakFatigueEnabled(flagOn); // not as shipped (when false): the off arm of the on/off read, a fresh game each
  const accrue = vi.spyOn(GameSessionAdapter.prototype as never, "accrueNightFatigue" as never) as unknown as { mock: { calls: unknown[] }; mockRestore(): void };
  let wraps = 0, m = 0;
  try {
    for (let i = 0; i < 4000 && wraps < 3; i++) {
      s.noteMessage({ messageId: `m${m++}` });
      const g = s.getGameState();
      if (g.pending && g.pending.kind !== "ceremony-step") { const r = answerPending(g.pending); if (r) s.submitDecision(r); continue; }
      const v = s.advanceGame();
      if (v.event?.beat === "day-break") wraps++;
    }
    return { wraps, accruals: accrue.mock.calls.length, fatigue: s.snapshot().live.playerFatigue };
  } finally { accrue.mockRestore(); }
}

describe("a day-break wrap the player stayed up through accrues the night (played)", () => {
  it("each wrap accrues once; before the fix none did", () => {
    const on = stayUp(true), off = stayUp(false);
    expect(on.wraps, "positive control: the player reached day-break wraps without turning in").toBeGreaterThanOrEqual(2);
    expect(off.accruals, "the old behaviour: the wrap bypassed the accrual").toBe(0);
    expect(on.accruals, "one accrual per wrap").toBe(on.wraps);
    expect(on.fatigue, "the meter holds the nights now").toBeDefined();
  }, 600_000);
});
