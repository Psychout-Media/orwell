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

  // ORW-345: the FE stamps `metadata.game_day` on every saved row from `getGameState().dayNumber`; without it on that view no row was ever stamped live and the closed-day prompt condensing (ORW-271) never ran.
  it("getGameState carries the same day number as its clock label and as the status, while the clock runs", () => {
    const s = started(3);
    let seen = 0;
    for (let i = 0; i < 60; i++) {
      s.advanceGame();
      const v = s.getGameState() as { clockLabel?: string; dayNumber?: number };
      if (v.clockLabel) {
        seen++;
        expect(v.dayNumber, v.clockLabel).toBe(Number(/Day (\d+)$/.exec(v.clockLabel)![1]));
        expect(v.dayNumber).toBe(s.gameStatus().dayNumber);
      } else expect(v.dayNumber).toBeUndefined();
    }
    expect(seen).toBeGreaterThan(5);
  });

  it("is absent from getGameState when the clock is off", () => {
    GameSessionAdapter.setTimeOfDayEnabled(false);
    const sb = new GameSessionRegistry().sandboxFor("hud-day-view-off");
    sb.session.createCharacter({ playerName: "P", seed: 3 });
    expect((sb.session.getGameState() as { dayNumber?: number }).dayNumber).toBeUndefined();
  });
});
