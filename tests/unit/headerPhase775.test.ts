import { describe, it, expect } from "vitest";
import { playedGame } from "../support/playedGame";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/**
 * ORW-775: the engine decides the header's phase once (`daySchedule.headerPhase`), so the status panel and the reply stamp read one value. In a played game, while the clock runs: it names today's event when
 * the next waits behind its night (ORW-258), the HOH day while a Day-2+ premiere has the HOH competition next (ORW-705), and otherwise the phase itself. Roles only.
 */
type View = { phase: string; dayNumber?: number; daySchedule?: { headerPhase: string; next: string; todaysEvent?: string } };

describe("daySchedule.headerPhase (played)", () => {
  it("follows the two header rules at every turn of the first two weeks", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const g = playedGame({ seed: 3, user: "hp775" });
    g.s.setPerConversationClockEnabled(true);
    let checked = 0, premiereDay2 = 0, today = 0;
    for (let i = 0; i < 1500; i++) {
      const v = g.s.getGameState() as unknown as View & { week?: number };
      const ds = v.daySchedule;
      if (ds) {
        const want = ds.todaysEvent ?? (v.phase === "premiere" && (v.dayNumber ?? 1) >= 2 && ds.next === "hoh-competition" ? "hoh-competition" : v.phase);
        expect(ds.headerPhase, `turn ${i}`).toBe(want);
        checked++;
        if (ds.todaysEvent) today++;
        else if (v.phase === "premiere" && ds.headerPhase === "hoh-competition") premiereDay2++;
      }
      if ((v.week ?? 1) > 2 || g.turn().finished) break;
    }
    GameSessionAdapter.setTimeOfDayEnabled(null);
    expect(checked, "the schedule was present").toBeGreaterThan(20);
    expect(today + premiereDay2, "a header rule applied in play").toBeGreaterThan(0);
  }, 600_000);
});
