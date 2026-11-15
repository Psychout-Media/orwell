import { describe, it, expect, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { finalHohPartOf, milestoneLabel, MILESTONE_LABEL } from "../../src/engine/daySchedule";
import { resolvePending } from "../../features/support/answerPending";

/**
 * ORW-370 (Ryne, 11-15: the status panel is "a guide to player on what to expect"): the three-part Final HOH (0128) is three competitions on the ONE `hoh-competition` milestone, so the
 * schedule could not say which part comes next. The view now names it (`daySchedule.finalHohPart`) - a LABEL only: the milestone beat, due-ness, minutes and the A65 hold are the ordinary
 * HOH milestone's, identical with the flag on or off. Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

let n = 0;
function toFinalThree(seed: number, on: boolean) {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const reg = new GameSessionRegistry();
  const s = reg.sandboxFor(`fhps-${n++}`).session;
  s.createCharacter({ playerName: "P", seed });
  s.setFinalHohThreePartEnabled(on);
  for (let i = 0; i < 6000; i++) {
    const st = s.getGameState();
    const active = st.house.filter((h) => h.status === "active").length + (st.player?.status === "active" ? 1 : 0);
    if (st.phase === "hoh-competition" && active === 3) { s.setPerConversationClockEnabled(true); return s; }
    const v = s.advanceGame();
    if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
    if (v.finished) return null;
  }
  return null;
}

describe("ORW-370 - the schedule names the Final HOH part", () => {
  it("pure: the label names the part only for the HOH milestone, and the part is read from the live state", () => {
    expect(milestoneLabel("hoh-competition", 2)).toBe("Final HOH part 2");
    expect(milestoneLabel("hoh-competition", null)).toBe(MILESTONE_LABEL["hoh-competition"]);
    expect(milestoneLabel("nominations", 3)).toBe(MILESTONE_LABEL.nominations);
    const live = { beat: "hoh-competition", active: ["a", "b", "c"], finalHohPart: 2 } as never;
    expect(finalHohPartOf(live, true)).toBe(2);
    expect(finalHohPartOf({ beat: "hoh-competition", active: ["a", "b", "c"] } as never, true)).toBe(1);
    expect(finalHohPartOf(live, false)).toBeNull();
    expect(finalHohPartOf({ beat: "hoh-competition", active: ["a", "b", "c", "d"] } as never, true)).toBeNull();
    expect(finalHohPartOf({ beat: "nominations", active: ["a", "b", "c"] } as never, true)).toBeNull();
  });

  it("live: every part is named from the schedule, and the milestone/hold fields are identical to the flag-off schedule", () => {
    let checked = 0;
    for (let seed = 1; seed <= 12 && checked < 1; seed++) {
      const on = toFinalThree(seed, true);
      const off = toFinalThree(seed, false);
      if (!on || !off) continue;
      const a = on.getGameState().daySchedule, b = off.getGameState().daySchedule;
      expect(a, `seed ${seed}`).toBeDefined();
      expect(a!.finalHohPart, "part 1 is named before the tournament starts").toBe(1);
      expect(b!.finalHohPart, "flag off: an ordinary HOH, no part").toBeUndefined();
      const { finalHohPart: _p, ...rest } = a!;
      expect(rest, "the hold/priming inputs (next, phase, due, minutesUntil, tomorrow) are untouched").toEqual(b);
      // Part 2 and part 3 follow once the earlier parts are crowned.
      const seen = new Set<number>([a!.finalHohPart!]);
      for (let i = 0; i < 400 && seen.size < 3; i++) {
        const v = on.advanceGame();
        if (v.pending) resolvePending(v.pending, (req) => void on.submitDecision(req));
        const ds = on.getGameState().daySchedule;
        if (ds?.finalHohPart) { expect(ds.next).toBe("hoh-competition"); seen.add(ds.finalHohPart); }
        if (v.finished) break;
      }
      expect([...seen].sort(), `seed ${seed}`).toEqual([1, 2, 3]);
      checked += 1;
    }
    expect(checked, "a game reached Final 3").toBeGreaterThan(0);
  }, 240_000);
});
