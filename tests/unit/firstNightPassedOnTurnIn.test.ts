import { describe, it, expect, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/** ORW-400 part 3: turnIn bumps dayNumber in materializeDailyRecap before playerTurnIn, so the week-1 first-night gate was never marked. Roles only. */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

describe("the premiere-night bedtime marks the first night as passed", () => {
  it("after the week-1 turnIn on day 1 the day rolled and firstNightPassed is set", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionRegistry().sandboxFor("fnp-premiere").session as any;
    s.setPremiereEntrancesEnabled(true);
    s.createCharacter({ playerName: "P", seed: 5 });
    s.setPerConversationClockEnabled(true);
    for (let i = 0; i < 40 && s.getGameState().phase === "premiere"; i++) { if (s.advanceGame().pending) break; }
    for (let i = 0; i < 400 && !["night", "late-night"].includes(s.gameStatus().timeOfDay); i++) s.noteMessage({ messageId: `m${i}` });
    const live = () => s.snapshot().live;
    expect(live().week).toBe(1);
    expect(live().firstNightPassed, "not yet: nobody has slept").toBeFalsy();
    const v = s.turnIn();
    expect(v.held).toBeUndefined();
    expect(live().dayNumber).toBe(2);
    expect(live().firstNightPassed).toBe(true);
  });
});
