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

describe("entrances ON + clock ON (the shipped combination)", () => {
  for (const seed of [3, 11, 21]) {
    it(`seed ${seed}: done -> first night (20:00) -> day-break at 8am, no comp card, HOH not due; the morning holds 48 messages; then the HOH stages in the afternoon (ORW-116 a)`, () => {
      const s = shipped(seed);
      // The premiere has no clock: nothing has started the day yet.
      expect(live(s).timeOfDay, "no clock during the entrances").toBeUndefined();
      walkToDone(s);
      expect(live(s).timeOfDay, "no clock during the toast either").toBeUndefined();
      expect(live(s).hoh).toBeUndefined();

      // ORW-116 (a, Ryne): the premiere and toast were the EVENING; the next advance starts the first NIGHT (20:00) with no comp card, and the first HOH is not due that night.
      const n = s.advanceGame();
      expect(n.pending ?? null, "the first-night day-break opens no competition card").toBeNull();
      expect(live(s).timeOfDay).toBe("night");
      expect(live(s).nightDepth).toBe(20);
      expect(milestoneDue(live(s) as never), "the first HOH is not due on the premiere night").toBe(false);

      // ONE more advance: the first night is crossed to the first morning (day-break).
      const v = s.advanceGame();
      expect(v.pending ?? null, "the day-break opens no competition card").toBeNull();
      expect(live(s).pending ?? null).toBeNull();
      expect(live(s).hoh, "no HOH yet").toBeUndefined();
      expect(live(s).nightDepth, "the day starts at 8am").toBe(8);
      expect(milestoneDue(live(s) as never), "the first HOH is not due at the day-break").toBe(false);

      // Spend the morning: 47 ordinary messages leave it not yet due; the 48th reaches noon and makes it due.
      for (let i = 0; i < 47; i++) s.advanceClockPerConversation();
      expect(milestoneDue(live(s) as never)).toBe(false);
      expect(live(s).nightDepth!).toBeLessThan(12);
      s.advanceClockPerConversation();
      expect(live(s).nightDepth!).toBeCloseTo(12, 5);
      expect(milestoneDue(live(s) as never), "the HOH is due at noon").toBe(true);

      // The HOH then stages (a competition card), still no winner yet: the player commits an approach first.
      const hohView = s.advanceGame();
      expect(hohView.pending?.kind, "the HOH competition stages once it is due").toMatch(/^comp-/);
      expect(live(s).hoh).toBeUndefined();
    });
  }

  it("mid-morning the engine reports the HOH NOT due (the signal the FE and hang-out gate on); an explicit advanceGame is not itself gated", () => {
    const s = shipped(11);
    walkToDone(s);
    s.advanceGame(); // the day-break
    for (let i = 0; i < 10; i++) s.advanceClockPerConversation(); // ~50 minutes of the morning
    expect(s.milestoneDue(), "adapter-level due flag stays false mid-morning").toBe(false);
    expect(milestoneDue(live(s) as never)).toBe(false);
    expect(live(s).hoh).toBeUndefined();
    // Pinned observation (not a requirement): advanceGame itself does not consult milestoneDue; the gate is the FE/hang-out reading it.
  });
});
