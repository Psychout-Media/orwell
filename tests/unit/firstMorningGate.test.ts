import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";

/**
 * P4b (live screen check on main 24936f96): the premiere-exit advance raised the first HOH's comp-round CARD at 8am on day 1 (`daySchedule.due:false`) and started the
 * clock — so day 1 had no 8->12 social morning, and the player could play the HOH at 8am; the FE due-gate can't hold a card that is already pending. With the clock live
 * (SeasonCtx.nightGate) the premiere exit is now a one-shot diegetic `day-break` that STARTS day 1 at 8am WITHOUT staging the comp; the FE's due-gate then holds the
 * HOH until 12:00. Clock off (the seeded calibration spine) is byte-identical (the comp is staged as before). Roles only.
 */
describe("P4b / ORW-116 - the first HOH waits for Day 2 (no phase advance moves the clock)", () => {
  afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));
  const play = (clock: boolean) => {
    GameSessionAdapter.setTimeOfDayEnabled(clock);
    const s = new GameSessionRegistry().sandboxFor(`fm-${clock}-${Math.random()}`).session;
    s.createCharacter({ playerName: "P", archetype: "floater", seed: 7 });
    s.setPerConversationClockEnabled(clock);
    s.advanceGame(); // the champagne-circle close
    if (clock) for (let i = 0; i < 80; i++) s.noteMessage({ messageId: `m${i}` }); // the player socializes through the evening into the night (starts + arms the clock)
    return s;
  };

  it("clock live (Ryne): the premiere exit moves NO time and rolls NO night; the first HOH is not raised that night; turning in starts Day 2", () => {
    const s = play(true);
    const hour = s.snapshot().live!.nightDepth!;
    expect(hour).toBeGreaterThan(20); // the premiere night
    const exit = s.advanceGame();
    expect(exit.held, "the premiere exit is held: the first night is the player's to spend").toBeDefined();
    expect(exit.event ?? null).toBeNull();
    expect(exit.pending ?? null, "the first HOH comp must NOT be raised on the premiere night").toBeNull();
    expect(s.snapshot().live!.nightDepth, "advancing moved no time").toBe(hour);
    expect(s.snapshot().live!.dayNumber ?? 1).toBe(1);
    s.turnIn();
    const live = s.snapshot().live!;
    expect(live.dayNumber).toBe(2);
    expect((s.getGameState().daySchedule as { due: boolean }).due).toBe(false); // the HOH is the afternoon of Day 2
    let started = false; // the premiere exit, then the HOH comp (the FE holds these calls until the HOH is due)
    for (let i = 0; i < 4 && !started; i++) {
      const next = s.advanceGame();
      expect(next.held ?? null, "after turning in nothing is held").toBeNull();
      started = next.pending?.kind === "comp-round" || next.event?.beat === "hoh-competition" || next.event?.beat === "comp-elimination";
    }
    expect(started).toBe(true);
  });

  it("the premiere night itself: the clock reads night on Day 1 and the first HOH is NOT due (it is the next afternoon)", () => {
    const s = play(true);
    const live = s.snapshot().live!;
    expect(live.timeOfDay).toBe("night");
    expect(live.dayNumber ?? 1).toBe(1);
    expect((s.getGameState().daySchedule as { due: boolean }).due).toBe(false);
  });

  it("clock off (calibration spine): byte-identical - the premiere exit still stages the HOH comp immediately", () => {
    const s = play(false);
    const v = s.advanceGame();
    expect(v.held ?? null).toBeNull();
    expect(v.pending?.kind === "comp-round" || v.event !== undefined).toBe(true);
  });
});
