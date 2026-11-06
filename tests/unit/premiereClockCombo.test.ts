import { describe, it, expect, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { milestoneDue } from "../../src/engine/daySchedule";

/**
 * Card 23 item 1 - the SHIPPED COMBINATION: premiere entrances ON + the in-game clock ON (+ the per-conversation clock).
 * Nothing else exercised it: the 0111 morning scenario runs with entrances OFF, the entrance tests run with no clock, and UAT/property/calibration run entrances ON with the clock OFF.
 * Walk entrances -> toast -> done -> ONE more advance: the day-break lands at 8am with NO competition card and the first HOH NOT due. Spend the Day-1 morning (48 ordinary
 * messages at 5 minutes); the HOH is due only at noon and then stages in the afternoon. Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

function shipped(seed: number) {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const sb = new GameSessionRegistry().sandboxFor(`combo-${seed}-${Math.random()}`);
  const s = sb.session as GameSessionAdapter;
  s.setPremiereEntrancesEnabled(true);
  s.createCharacter({ playerName: "The Player", archetype: "floater", seed });
  s.setPerConversationClockEnabled(true);
  return s;
}
const live = (s: GameSessionAdapter) => s.snapshot().live as unknown as { nightDepth?: number; timeOfDay?: string; pending?: { kind: string }; hoh?: string; premiereEntrance?: { stage: string }; champagneCircle?: string };
const stage = (s: GameSessionAdapter): string | undefined => s.premiereIntros()?.entrance?.stage;

function walkToDone(s: GameSessionAdapter): void {
  for (let i = 0; i < 60 && stage(s) !== "done"; i++) s.advanceGame();
  expect(stage(s), "entrances then the toast then done").toBe("done");
}

const talk = (s: GameSessionAdapter, n: number, tag: string) => { for (let i = 0; i < n; i++) s.noteMessage({ messageId: `${tag}${i}` }); };

describe("entrances ON + clock ON (the shipped combination)", () => {
  for (const seed of [3, 11, 21]) {
    it(`seed ${seed}: the clock runs from the afternoon entry through the toast (no jump); the first night is the player's; turning in rolls it; the HOH is Day 2's afternoon (ORW-116)`, () => {
      const s = shipped(seed);
      expect(live(s).timeOfDay, "nothing has started the clock before the first entrance").toBeUndefined();
      walkToDone(s);
      // Ryne: houseguests ENTER in the afternoon; the clock runs for real through the entrances, so the toast is the evening - no phase advance moved it.
      expect(live(s).nightDepth!, "the toast is the evening").toBeGreaterThan(17);
      expect(live(s).nightDepth!).toBeLessThan(21);
      expect(live(s).hoh).toBeUndefined();

      // The player socializes into the night; the premiere exit (a plain advance) does NOT roll it.
      talk(s, 40, "m");
      const hour = live(s).nightDepth!;
      for (let i = 0; i < 4; i++) {
        const v = s.advanceGame();
        expect(v.held, "the night is never auto-run").toBeDefined();
        expect(v.pending ?? null).toBeNull();
      }
      expect(live(s).nightDepth, "advances move no time").toBe(hour);
      expect(milestoneDue(live(s) as never), "the first HOH is not due on the premiere night").toBe(false);

      // Turning in rolls the night (Day 2); the HOH is not due in the morning, and is due at noon.
      s.turnIn();
      expect(live(s).hoh, "no HOH yet").toBeUndefined();
      expect(milestoneDue(live(s) as never), "not due at wake").toBe(false);
      for (let i = 0; i < 200 && (live(s).nightDepth ?? 0) < 12 - 1e-6; i++) talk(s, 1, `d${i}`);
      s.advanceClockPerConversation();
      expect(milestoneDue(live(s) as never), "the HOH is due once it is Day 2 noon").toBe(true);
      const hohView = s.advanceGame();
      expect(hohView.pending?.kind, "the HOH competition stages once it is due").toMatch(/^comp-/);
      expect(live(s).hoh).toBeUndefined();
    });
  }
});
