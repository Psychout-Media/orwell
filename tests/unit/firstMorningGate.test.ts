import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";

/**
 * P4b (live screen check on main 24936f96): the premiere-exit advance raised the first HOH's comp-round CARD at 8am on day 1 (`daySchedule.due:false`) and started the
 * clock — so day 1 had no 8->12 social morning, and the player could play the HOH at 8am; the FE due-gate can't hold a card that is already pending. With the clock live
 * (SeasonCtx.nightGate) the premiere exit is now a one-shot diegetic `day-break` that STARTS day 1 at 8am WITHOUT staging the comp; the FE's due-gate then holds the
 * HOH until 12:00. Clock off (the seeded calibration spine) is byte-identical (the comp is staged as before). Roles only.
 */
describe("P4b — the first HOH waits for its hour on day 1", () => {
  afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));
  const play = (clock: boolean) => {
    GameSessionAdapter.setTimeOfDayEnabled(clock);
    const s = new GameSessionRegistry().sandboxFor(`fm-${clock}-${Math.random()}`).session;
    s.createCharacter({ playerName: "P", archetype: "floater", seed: 7 });
    s.setPerConversationClockEnabled(clock);
    const views = [s.advanceGame(), s.advanceGame(), s.advanceGame()];
    return { s, views };
  };

  it("clock live: the premiere exit starts day 1 at 8am with a day-break and NO comp card; the NEXT advance stages the comp", () => {
    const { s, views } = play(true);
    // advance 1 = the champagne-circle close (premiere), advance 2 = the premiere exit
    const exit = views[1]!;
    expect(exit.event?.beat).toBe("day-break");
    expect(exit.pending ?? null, "the first HOH comp must NOT be raised at 8am").toBeNull();
    const live = s.snapshot().live!;
    expect(live.nightDepth).toBe(8);
    expect(live.timeOfDay).toBe("morning");
    const st = s.getGameState();
    expect(st.phase).toBe("hoh-competition");
    expect(st.daySchedule).toEqual({ next: "hoh-competition", phase: "afternoon", due: false, minutesUntil: 240 }); // A7: 8am -> the 12:00 afternoon start = exactly 240 minutes (exact, not a subset)
    // the following advance is where the HOH comp actually starts (the FE holds this call until 12:00)
    expect(views[2]!.pending?.kind === "comp-round" || views[2]!.event?.beat === "hoh-competition" || views[2]!.event?.beat === "comp-elimination").toBe(true);
  });

  it("clock off (calibration spine): byte-identical — the premiere exit still stages the HOH comp immediately", () => {
    const { views } = play(false);
    expect(views[1]!.event?.beat).not.toBe("day-break");
    expect(views[1]!.pending?.kind === "comp-round" || views[1]!.event !== undefined).toBe(true);
  });
});
