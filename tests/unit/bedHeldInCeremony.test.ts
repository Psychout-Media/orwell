import { describe, it, expect, afterEach } from "vitest";
import { toDayTwoMorning } from "../support/dayTwoMorning";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";

/**
 * ORW-446 (BDD Auditor, ORW-433 probe): a goodnight during an open ceremony (the staged eviction reveal) went through and the reveal resumed the next evening; one eviction once stretched over 4 days.
 * Like moves and naps, the bed is held until the event finishes. Played games only. Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(false));

const CEREMONY = { kind: "eviction", hold: "eviction", steps: ["intro", "ballot"], at: 0 }; // a staged ceremony part-way through

function night(played: boolean) {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const s = new GameSessionRegistry().sandboxFor(`bedhold-${Math.random()}`).session as GameSessionAdapter;
  s.createCharacter({ playerName: "P", seed: 7 });
  s.setPerConversationClockEnabled(true);
  toDayTwoMorning(s);
  s.setBedtimeGateEnabled(true); // the unit lane defaults it off (premiereTestDefault); the deployed game has it on
  const live = (s as unknown as { live: Record<string, unknown> }).live;
  live.playedGame = played ? true : undefined;
  live.timeOfDay = "night"; live.nightDepth = 21;
  return { s, live };
}

describe("ORW-446 - a goodnight is held while a ceremony is open", () => {
  it("an open staged ceremony holds the bed: typed held, nothing moves; once it closes the same bed goes through", () => {
    const { s, live } = night(true);
    live.ceremony = CEREMONY;
    const before = s.getGameState() as { beatSeq: number; timeOfDay?: string };
    const v = s.turnIn();
    expect(v.held).toEqual({ next: "ceremony", minutesUntil: 0, reason: "ceremony" });
    const after = s.getGameState() as { beatSeq: number; timeOfDay?: string };
    expect(after.beatSeq, "no commit").toBe(before.beatSeq);
    expect(after.timeOfDay, "the clock/phase did not move").toBe(before.timeOfDay);
    expect(live.dayNumber, "the day did not roll").toBe(2);
    delete live.ceremony;
    const ok = s.turnIn();
    expect(ok.held).toBeUndefined();
    expect(live.dayNumber, "the bed rolled the day once the ceremony closed").toBe(3);
  });
  it("an open player decision holds the bed too", () => {
    const { s, live } = night(true);
    live.pending = { kind: "ceremony-step" };
    expect(s.turnIn().held?.reason).toBe("ceremony");
  });
  it("a headless (not played) game is never held: byte-identical", () => {
    const { s, live } = night(false);
    live.ceremony = CEREMONY;
    expect(s.turnIn().held).toBeUndefined();
  });
  it("the bedtime-gate switch the harnesses flip turns the hold off with it", () => {
    const { s, live } = night(true);
    live.ceremony = CEREMONY;
    s.setBedtimeGateEnabled(false);
    expect(s.turnIn().held).toBeUndefined();
  });
});
