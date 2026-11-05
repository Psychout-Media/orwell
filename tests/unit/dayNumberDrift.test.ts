import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { resolvePending } from "../../features/support/answerPending";

/**
 * A70 - the dayNumber audit, pinned. `dayNumber` only increments through the daily recap (player turn-in), but the schedule rolls the clock to a fresh 8:00am for every next milestone (A69). Every consumer
 * therefore sees a clock that goes BACKWARDS inside "Day 1":
 *  - `absHour()` (days*24 + clock hour) is the desire clock's cooldown axis and RNG key: it drops at each roll, so `hoursSinceApproach` goes negative and the same hours-keyed stream repeats each day;
 *  - the hang-out "pulled at most once per day" cap (`hangOutPulledDay === day`) is really once per recap day, i.e. once per week of milestones;
 *  - the daily recap / confessional sweep key and the P0 clock label are turn-in-only (the label dropped its "Day N" for this reason).
 * No FE surface reads dayNumber (grep, 2026-11-05). `it.fails` = the KNOWN drift: it goes red the day A69 fixes the accounting, and the entry is then deleted deliberately. Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(false));
type Priv = { absHour(): number; snapshot(): { live: { dayNumber?: number; nightDepth?: number } } };

function playUntilRolls(out?: { day?: number }): number[] {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const s = new GameSessionRegistry().sandboxFor(`dn-${Math.random()}`).session as GameSessionAdapter;
  s.createCharacter({ playerName: "P", seed: 7 });
  s.setPerConversationClockEnabled(true);
  const p = s as unknown as Priv;
  const live = () => p.snapshot().live;
  for (let i = 0; i < 80 && live().nightDepth === undefined; i++) s.advanceGame();
  const abs: number[] = [p.absHour()];
  let rolls = 0, last = live().nightDepth!;
  for (let step = 0; step < 400 && rolls < 3; step++) {
    const st = s.getGameState() as { daySchedule?: { due: boolean } };
    if (st.daySchedule?.due) {
      const v = s.advanceGame();
      if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
    } else s.advanceClockPerConversation();
    abs.push(p.absHour());
    const h = live().nightDepth!;
    if (h < last - 1) rolls++;
    last = h;
  }
  if (out) out.day = live().dayNumber;
  expect(rolls, "precondition: the clock rolled to a fresh morning at least once").toBeGreaterThan(0);
  return abs;
}

describe("A70 - dayNumber consumers (known drift, A69)", () => {
  it("dayNumber is still 1 (unset) after several milestone rolls - only a turn-in moves it; pinned as today's behavior", () => {
    const out: { day?: number } = {};
    const abs = playUntilRolls(out);
    expect(abs.length).toBeGreaterThan(10);
    expect(out.day ?? 1, "A69 fixes this: dayNumber should follow the roll").toBe(1);
  });
  it.fails("absHour never goes backwards across a milestone roll (DRIFT: it does - the desire clock's cooldown axis)", () => {
    const abs = playUntilRolls();
    for (let i = 1; i < abs.length; i++) expect(abs[i]!, `absHour went ${abs[i - 1]} -> ${abs[i]}`).toBeGreaterThanOrEqual(abs[i - 1]! - 1e-9);
  });
});
