import { describe, it, expect, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/** ORW-1165: a closed day's recap is rebuilt on request with the current digest builder, also for a recap made before the record slices were kept (a save from before). Roles only. */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

describe("ORW-1165 - rebuildDay", () => {
  it("rebuilds the latest closed day from the live cursor when no slice was kept, and reads nothing it should not", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionRegistry().sandboxFor("recap-rebuild").session as any;
    s.setPremiereEntrancesEnabled(true);
    s.createCharacter({ playerName: "P", seed: 5 });
    s.setPerConversationClockEnabled(true);
    for (let i = 0; i < 40 && s.getGameState().phase === "premiere"; i++) { if (s.advanceGame().pending) break; }
    for (let i = 0; i < 400 && !["night", "late-night"].includes(s.gameStatus().timeOfDay); i++) s.noteMessage({ messageId: `m${i}` });
    const v = s.turnIn();
    const r = v.dailyRecap!;
    expect(r.highlights.length).toBeGreaterThan(0);
    expect(s.dailyRecap({ rebuildDay: 1 }).digest).toEqual(r.digest);
    delete s.live.dailyRecapRanges; // a save from before the slices were kept
    expect(s.dailyRecap({ rebuildDay: 1 }).digest).toEqual(r.digest);
    expect(s.dailyRecap({ rebuildDay: 2 })).toBeNull();
    expect(s.dailyRecap()).toEqual(r); // a pure read: the stored recap is untouched
  });
});
