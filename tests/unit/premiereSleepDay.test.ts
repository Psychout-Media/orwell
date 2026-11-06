import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";

/** Found in the live week-1 run: the player went to bed on premiere night, and the next morning the clock label read "Day 3" (it should be Day 2). Roles only. */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(false));

describe("the day number across the premiere night", () => {
  it("one night's sleep from the premiere moves the label from Day 1 to Day 2, not Day 3", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionRegistry().sandboxFor(`ps-${Math.random()}`).session as GameSessionAdapter;
    s.createCharacter({ playerName: "P", seed: 7 });
    s.setPerConversationClockEnabled(true);
    const label = () => (s.getGameState() as { clockLabel?: string; phase?: string }).clockLabel;
    const turnIn = (s as unknown as { turnIn: (r?: unknown) => unknown }).turnIn.bind(s);
    // the live path: the player says goodnight DURING the premiere (the clock may not be live yet), the house sleeps, then they talk through the morning
    turnIn({});
    for (let i = 0; i < 40 && !label(); i++) s.advanceClockPerConversation();
    for (let i = 0; i < 4; i++) s.advanceGame();
    for (let i = 0; i < 4; i++) s.advanceClockPerConversation();
    const seen = label();
    // (the phase after the advances is not part of this contract - main now rolls out of the premiere on the second advance - only the day label is)
    expect(seen, "label exists").toBeTruthy();
    expect(seen).toMatch(/am, Day 2$/);
  });
});
