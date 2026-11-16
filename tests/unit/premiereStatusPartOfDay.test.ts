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

describe("a message announced before any game exists", () => {
  it("is refused (accepted false, a reason, nothing changed) and then works once the game exists", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionRegistry().sandboxFor(`pre-note-${Math.random()}`).session as GameSessionAdapter;
    const before = s.noteMessage({ messageId: "casting-1" });
    expect(before).toMatchObject({ accepted: false, reason: "no-game" });
    expect(s.noteMessage({ messageId: "casting-1" }).beatSeq, "no state change: the counter did not move").toBe(before.beatSeq);
    s.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
    s.setPerConversationClockEnabled(true);
    expect(s.noteMessage({ messageId: "casting-1" }), "the same id was NOT remembered while there was no game").toMatchObject({ accepted: true });
    expect(s.gameStatus().timeOfDay).toBe("evening");
  });

  it("during premiere entrances (created, none advanced yet: the clock has not started) the status names the part of day", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionRegistry().sandboxFor(`pre-ent-${Math.random()}`).session as GameSessionAdapter;
    s.setPremiereEntrancesEnabled(true); // the unit lane pins the flag off; the shipped game has it on
    s.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
    s.setPerConversationClockEnabled(true);
    const live = s.snapshot().live as { nightDepth?: number; premiereEntrance?: { stage: string; arrived: number; playerPos: number } };
    expect(live.premiereEntrance?.stage).toBe("entrances");
    expect(live.premiereEntrance?.arrived, "the houseguests seated at creation are not clock steps").toBe(live.premiereEntrance?.playerPos);
    expect(live.nightDepth).toBeUndefined();
    expect(s.gameStatus()).toMatchObject({ phase: "premiere", timeOfDay: "evening", dayNumber: 1 });
    s.advanceGame(); // the first ADVANCED entrance starts the clock
    expect((s.snapshot().live as { nightDepth?: number }).nightDepth).toBeDefined();
  });
});
