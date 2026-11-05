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
    const phase = () => (s.getGameState() as { phase?: string }).phase;
    const turnIn = (s as unknown as { turnIn: (r?: unknown) => unknown }).turnIn.bind(s);
    // the live path: the player says goodnight DURING the premiere (the clock may not be live yet), the house sleeps, then they talk through the morning
    turnIn({});
    const trace: string[] = [];
    for (let i = 0; i < 40 && !label(); i++) s.advanceClockPerConversation();
    trace.push(`after sleep: ${label()} / ${phase()}`);
    for (let i = 0; i < 4; i++) { s.advanceGame(); trace.push(`advanceGame ${i}: ${label()} / ${phase()}`); }
    console.log("PS-TRACE\n" + trace.join("\n"));
    for (let i = 0; i < 4; i++) s.advanceClockPerConversation();
    const seen = label();
    expect(phase(), "still the premiere morning").toBe("premiere");
    expect(seen, "label exists").toBeTruthy();
    expect(seen).toMatch(/am, Day 2$/);
  });
});
