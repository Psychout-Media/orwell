import { describe, it, expect, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/** ORW-691 B1-4 (0194): a bad night's sleep must be reachable. Played through the real writers: real messages carry the clock to the small hours, then the player turns in (no state injected). Roles only. */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));
describe("ORW-691 B1-4: the bad-sleep mood cause fires after a played late night", () => {
  for (const seed of [3, 11]) for (const on of [true, false]) it(`seed ${seed}, reach ${on ? "on" : "off (the old bar)"}`, () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionRegistry().sandboxFor(`orw691-sleep-${seed}`).session as any;
    s.setBadSleepReachEnabled(on);
    s.setPremiereEntrancesEnabled(true);
    s.createCharacter({ playerName: "P", seed });
    s.setPerConversationClockEnabled(true);
    for (let i = 0; i < 40 && s.getGameState().phase === "premiere"; i++) { if (s.advanceGame().pending) break; }
    for (let i = 0; i < 600 && (s.snapshot().live.nightDepth ?? 0) < 26; i++) s.noteMessage({ messageId: `m${i}` });
    const v = s.turnIn();
    const log = (s.snapshot().live.moodCauseLog ?? []) as Array<{ source: string }>;
    expect(v).toBeTruthy();
    expect(log.some((c) => c.source === "bad-sleep")).toBe(on);
  }, 120_000);
});
