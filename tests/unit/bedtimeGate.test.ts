import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { resolvePending } from "../../features/support/answerPending";

/** Found in the live week-1 run: the narrator called `turnIn` on "wake up in the morning" and the engine slept through a whole day (the clock went "8:00am, Day 2" -> "8:00am, Day 3"). A bed in the morning or afternoon is refused with a
 * typed `held` and commits nothing; from the evening on the player owns their bedtime as before. Roles only. */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(false));
type Peek = { snapshot(): { live: { dayNumber?: number; timeOfDay?: string; nightDepth?: number } }; setBedtimeGateEnabled(on: boolean): void };

function game(gate: boolean) {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const s = new GameSessionRegistry().sandboxFor(`bg-${Math.random()}`).session as GameSessionAdapter;
  s.createCharacter({ playerName: "P", seed: 7 });
  s.setPerConversationClockEnabled(true);
  (s as unknown as Peek).setBedtimeGateEnabled(gate);
  const live = () => (s as unknown as Peek).snapshot().live;
  for (let i = 0; i < 80 && live().nightDepth === undefined; i++) { const v = s.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req)); }
  s.advanceGame(); // ORW-116 (a): the premiere exit starts the first NIGHT; this advance crosses it to the first morning (8am)
  return { s, live };
}
const label = (s: GameSessionAdapter) => (s.getGameState() as { clockLabel?: string }).clockLabel;

describe("the bedtime gate", () => {
  it("a turn-in in the morning is refused (typed held, nothing moves); a second one is refused too", () => {
    const { s, live } = game(true);
    expect(live().timeOfDay).toBe("morning");
    const before = { label: label(s), seq: s.getGameState().beatSeq, day: live().dayNumber };
    const v = s.turnIn({});
    expect(v.held?.next).toBe("bedtime");
    expect(v.held?.minutesUntil).toBeGreaterThan(0);
    s.turnIn({});
    expect({ label: label(s), seq: s.getGameState().beatSeq, day: live().dayNumber }).toEqual(before);
  });
  it("with the gate off, a morning turn-in sleeps the day away exactly as before", () => {
    const { s, live } = game(false);
    const day0 = live().dayNumber ?? 1;
    const v = s.turnIn({});
    expect(v.held).toBeUndefined();
    expect(live().dayNumber ?? 1).toBeGreaterThan(day0);
  });
  it("from the evening on the player can still turn in (their bedtime, ADR 0006)", () => {
    const { s, live } = game(true);
    for (let i = 0; i < 400 && !["evening", "night", "late-night"].includes(live().timeOfDay ?? ""); i++) s.advanceClockPerConversation();
    expect(["evening", "night", "late-night"]).toContain(live().timeOfDay);
    const day0 = live().dayNumber ?? 1;
    const v = s.turnIn({});
    expect(v.held).toBeUndefined();
    expect(live().dayNumber ?? 1).toBeGreaterThan(day0);
  });
});
