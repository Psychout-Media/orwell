import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { resolvePending } from "../../features/support/answerPending";

/**
 * PO direction (Ryne, 2026-11-04): PRODUCTION owns the schedule, so the front-end no longer fires a competition/ceremony before `daySchedule.due`. That is only safe
 * if the in-game clock ALWAYS brings a due event in on its own while the player lingers - otherwise withholding the early fire would stall the game. This pins it:
 * from a not-yet-due milestone beat (e.g. 9am before an afternoon comp), ordinary social turns in ONE scene reach `due` within a bounded number of turns
 * (0.2h/turn, scene cap 4h >= the morning-to-afternoon gap). Roles only.
 */
describe("the per-conversation clock brings a scheduled milestone due on its own", () => {
  it("lingering turns in a single scene reach `daySchedule.due` (no stall when early-firing is withheld)", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    let checked = 0;
    for (const seed of [3, 5, 8]) {
      const s = new GameSessionRegistry().sandboxFor(`due${seed}`).session as GameSessionAdapter;
      s.createCharacter({ playerName: "P", seed });
      s.setPerConversationClockEnabled(true);
      for (let i = 0; i < 600; i++) {
        const v = s.advanceGame();
        if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
        const st = s.getGameState() as { daySchedule?: { due: boolean } };
        if (st.daySchedule && st.daySchedule.due === false && ((s.snapshot() as unknown as { live: { dayNumber?: number } }).live.dayNumber ?? 1) >= 2) { // ORW-116 (a): park on a MORNING (the first night is not one)
          let turns = 0;
          while (turns < 150 && !(s.getGameState() as { daySchedule?: { due: boolean } }).daySchedule?.due) { s.advanceClockPerConversation(); turns += 1; }
          expect(turns, `seed ${seed}: due within a bounded number of lingering turns`).toBeLessThan(150);
          expect((s.getGameState() as { daySchedule?: { due: boolean } }).daySchedule?.due).toBe(true);
          checked += 1;
          break;
        }
      }
    }
    expect(checked, "at least one seed exercised a not-yet-due milestone").toBeGreaterThan(0);
  });
});
