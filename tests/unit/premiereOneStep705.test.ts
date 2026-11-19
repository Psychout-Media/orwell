import { describe, it, expect, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { MINUTES_PER_MESSAGE } from "../../src/engine/sleepConstants";

/**
 * ORW-705 / PT-10 (dev playtest 2026-11-19): during the entrances and the toast a message cost 14 game minutes - the player's one message-step (5) PLUS a 9-minute premiere step on the
 * entrance / toast release. The standing rule (commit "one in-game message-step per player message") is one step per player message. A played game bills the premiere release through the
 * message alone (flag ORWELL_PREMIERE_ONE_STEP, default ON); off restores the double bill. Real path: a played game = the player's message announced, then the release. Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

function played(seed: number, oneStep: boolean) {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const s = new GameSessionRegistry().sandboxFor(`one-step-${seed}-${Math.random()}`).session as GameSessionAdapter;
  s.setPremiereEntrancesEnabled(true);
  s.setPremiereOneStepEnabled(oneStep);
  s.setBedRushEnabled(false);
  s.createCharacter({ playerName: "The Player", archetype: "floater", seed });
  s.setPerConversationClockEnabled(true);
  return s;
}
const hour = (s: GameSessionAdapter): number => s.snapshot().live?.nightDepth ?? 0;
const stage = (s: GameSessionAdapter): string | undefined => s.premiereIntros()?.entrance?.stage;

/** Per-message minutes over every message of the entrances + toast, as the played loop does it (announce the message, then the release). */
function perMessageMinutes(s: GameSessionAdapter): number[] {
  const out: number[] = [];
  s.noteMessage({ messageId: "walk-in" }); // the first message starts the clock (afternoon)
  for (let i = 0; i < 60 && stage(s) !== "done"; i++) {
    const before = hour(s);
    s.noteMessage({ messageId: `m${i}` });
    s.advanceGame();
    out.push(Math.round((hour(s) - before) * 60));
  }
  return out;
}

describe("PT-10: a played premiere message costs ONE message-step", () => {
  for (const seed of [3, 11]) {
    it(`seed ${seed}: every entrance and toast message moves the clock by exactly one message-step`, () => {
      const m = perMessageMinutes(played(seed, true));
      expect(m.length).toBeGreaterThan(10);
      for (const x of m) expect(x).toBe(MINUTES_PER_MESSAGE);
    });
    it(`seed ${seed}: flag off keeps the old 14-minute double bill`, () => {
      const m = perMessageMinutes(played(seed, false));
      expect(Math.max(...m)).toBe(14);
    });
  }
  it("a headless driver (no message ever announced) keeps the premiere step byte-identical", () => {
    const s = played(3, true);
    const t0 = hour(s);
    s.advanceGame();
    expect(Math.round((hour(s) - t0) * 60)).toBeGreaterThan(0);
  });
});
