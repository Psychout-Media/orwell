import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";

/**
 * ORW-115 (Ryne 2026-11-06: "Time of day only"): the HUD shows the time of day and the day number ("Morning, Day 1"), never exact minutes. The public status carries `dayNumber` beside `timeOfDay`, and it is
 * the SAME day the narrator is told in `clockLabel` ("9:40am, Day 1"). Present only while the clock runs. Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

function started(seed: number) {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const sb = new GameSessionRegistry().sandboxFor(`hud-day-${seed}`);
  sb.session.createCharacter({ playerName: "P", seed });
  return sb.session;
}

describe("the HUD day number", () => {
  it("status.dayNumber equals the day in the clock label, and tracks it as the days roll", () => {
    const s = started(3);
    for (let i = 0; i < 60; i++) {
      s.advanceGame();
      const st = s.gameStatus();
      const label = (s.getGameState() as { clockLabel?: string }).clockLabel;
      if (st.timeOfDay && label) {
        const m = /Day (\d+)$/.exec(label)!;
        expect(st.dayNumber, `after advance ${i}: ${label}`).toBe(Number(m[1]));
      }
    }
  });

  it("is absent when the clock is off (the chip stays hidden)", () => {
    GameSessionAdapter.setTimeOfDayEnabled(false);
    const sb = new GameSessionRegistry().sandboxFor("hud-day-off");
    sb.session.createCharacter({ playerName: "P", seed: 3 });
    expect(sb.session.gameStatus().dayNumber).toBeUndefined();
  });
});
