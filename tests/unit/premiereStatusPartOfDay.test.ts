import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";

/** The public status names the part of day on premiere night, before the clock has started (it used to omit it: the HUD header read "Week 1 Premiere" with nothing after it). Roles only. */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

function started(clockPacing = true) {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const s = new GameSessionRegistry().sandboxFor(`pre-${Math.random()}`).session as GameSessionAdapter;
  s.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  s.setPerConversationClockEnabled(clockPacing);
  return s;
}

describe("the status on premiere night", () => {
  it("carries the part of day and the day number before the clock starts, and does not start the clock", () => {
    const s = started();
    const st = s.gameStatus();
    expect(st.phase).toBe("premiere");
    expect(st.timeOfDay).toBe("evening");
    expect(st.dayNumber).toBe(1);
    expect((s.snapshot().live as { nightDepth?: number }).nightDepth, "reading the status never starts the clock").toBeUndefined();
    expect(s.gameStatus().beatSeq).toBe(st.beatSeq);
  });
  it("follows the clock once it runs (first player message: evening)", () => {
    const s = started();
    s.noteMessage({ messageId: "m1" });
    expect(s.gameStatus().timeOfDay).toBe("evening");
  });
  it("is absent when the clock is off (byte-identical to before)", () => {
    expect(started(false).gameStatus().timeOfDay).toBeUndefined();
    GameSessionAdapter.setTimeOfDayEnabled(false);
    const s = new GameSessionRegistry().sandboxFor("pre-off").session as GameSessionAdapter;
    s.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
    expect(s.gameStatus().timeOfDay).toBeUndefined();
  });
});
