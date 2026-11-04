import { describe, it, expect } from "vitest";
import { playerTurnIn, playerRestDeficit, advanceClockPerConversation, type LiveSeasonState } from "../../src/engine/liveSeason";
import { wakeHourAfterBed, isAwakeAtHour, restDeficitForDepth, WAKE_HOUR } from "../../src/engine/timeOfDay";
import { milestoneDue } from "../../src/engine/daySchedule";

/**
 * P4d (PO rule, Ryne 2026-11-04): the player wakes at 8am by default, but if they go to sleep EARLIER they wake earlier: wake = min(8am, bedtime + 8h). Bed at 10pm wakes at 6am;
 * bed at midnight or later wakes at 8am (with the sleep debt exactly as before). NPCs keep their own chronotype wakes, so the early-morning window is mostly asleep; nothing
 * scheduled fires before its hour (the due-gate is untouched). ASSUMED, pending Ryne: the earliest wake is 5am (a floor) and only an EVENING bed (>= 8pm) wakes early (a
 * daytime nap never wakes you before you lay down). Roles only.
 */
const at = (hour: number): LiveSeasonState => ({ nightDepth: hour, timeOfDay: "night", beat: "veto-competition", evictionOrder: [] } as unknown as LiveSeasonState);

describe("wake = min(8am, bedtime + 8h)", () => {
  it("10pm -> 6am; 9pm -> 5am (the floor); midnight -> 8am; 2am -> 8am", () => {
    expect(wakeHourAfterBed(22)).toBe(6);
    expect(wakeHourAfterBed(21)).toBe(5);
    expect(wakeHourAfterBed(20)).toBe(5);   // floor: never earlier than 5am
    expect(wakeHourAfterBed(24)).toBe(8);
    expect(wakeHourAfterBed(26)).toBe(8);
  });
  it("a daytime turn-in never wakes before the player lay down (falls back to the 8am wake)", () => {
    expect(wakeHourAfterBed(10)).toBe(WAKE_HOUR);
    expect(wakeHourAfterBed(17)).toBe(WAKE_HOUR);
  });
});

describe("turning in", () => {
  it("at 10pm the player wakes at 6am, rested (no debt)", () => {
    const s = at(22);
    playerTurnIn(s, "player");
    expect(s.nightDepth).toBe(6);
    expect(playerRestDeficit(s)).toBe(0);
    advanceClockPerConversation(s, 0);           // the wake advance: lands on the early hour, no hours move
    expect(s.nightDepth).toBe(6);
  });
  it("at midnight the player wakes at 8am (unchanged)", () => {
    const s = at(24); playerTurnIn(s, "player");
    expect(s.nightDepth).toBe(8);
  });
  it("at 2am the player wakes at 8am and carries the same debt as before", () => {
    const s = at(26); playerTurnIn(s, "player");
    expect(s.nightDepth).toBe(8);
    expect(playerRestDeficit(s)).toBeCloseTo(restDeficitForDepth(26), 9);
    expect(playerRestDeficit(s)).toBeGreaterThan(0);
  });
  it("the early-morning window cannot fire anything: a 12:00 event is not due at 6am", () => {
    const s = at(22); s.beat = "veto-competition" as never;
    playerTurnIn(s, "player"); advanceClockPerConversation(s, 0);
    expect(milestoneDue(s)).toBe(false);
  });
});

describe("the house at the early hour keeps its own chronotypes", () => {
  it("a lark who bedded at 10pm is up at 6am; an owl who bedded at 2am is still asleep", () => {
    expect(isAwakeAtHour(6, 22)).toBe(true);
    expect(isAwakeAtHour(6, 26)).toBe(false);
    expect(isAwakeAtHour(7.9, 25)).toBe(false);   // wakes at 9
  });
  it("the 8am-and-later behaviour is unchanged", () => {
    expect(isAwakeAtHour(8, 22)).toBe(true);
    expect(isAwakeAtHour(30, 22)).toBe(true);
    expect(isAwakeAtHour(25, 22)).toBe(false);
  });
});

import { afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";

describe("through the live session (turnIn)", () => {
  afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));
  function toHour(target: number): GameSessionAdapter {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionRegistry().sandboxFor(`wake-${Math.random()}`).session;
    s.createCharacter({ playerName: "P", archetype: "floater", seed: 7 });
    s.setPerConversationClockEnabled(true);
    s.advanceGame(); s.advanceGame();
    for (let i = 0; i < 2000 && (s.snapshot().live?.nightDepth ?? 0) < target; i++) s.advanceClockPerConversation();
    return s;
  }
  it("an evening turn-in (>= 10pm) wakes the player early, rested; the day clock then resumes from there", () => {
    const s = toHour(22);
    const bed = s.snapshot().live!.nightDepth!;
    expect(bed).toBeGreaterThanOrEqual(22);
    s.turnIn();
    const live = s.snapshot().live!;
    expect(live.nightDepth).toBe(wakeHourAfterBed(bed));
    expect(live.nightDepth!).toBeLessThan(8);
    expect(live.playerRetired).toBe(true);
  });
  it("a post-midnight turn-in wakes at 8am exactly as before, with the debt", () => {
    const s = toHour(25);
    s.turnIn();
    const live = s.snapshot().live!;
    expect(live.nightDepth).toBe(8);
    expect(live.wakeHour).toBeUndefined();
    expect(restDeficitForDepth(live.lastSleepDepth!)).toBeGreaterThan(0);
  });
});
