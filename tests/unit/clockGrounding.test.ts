import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { formatClockLabel } from "../../src/engine/timeOfDay";

/**
 * P0 clock grounding (A31 -> Coordinator): the narrator's moment prompt carries the engine's EXACT clock ("9:40am, Day 1") and is told to name no other time, so "it's noon" at 9:40 has nothing to
 * stand on. Prompt grounding only - no guard, no behavior change. Absent whenever the clock is not running (byte-identical). Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

describe("formatClockLabel", () => {
  it("renders the engine clock hour as a plain 12-hour label with the day", () => {
    expect(formatClockLabel(8, 1)).toBe("8:00am");
    expect(formatClockLabel(9 + 40 / 60, 1)).toBe("9:40am");
    expect(formatClockLabel(12, 1)).toBe("12:00pm");
    expect(formatClockLabel(13.25, 2)).toBe("1:15pm");
    expect(formatClockLabel(24, 3)).toBe("12:00am");
    expect(formatClockLabel(27 + 5 / 60, 3)).toBe("3:05am");
    expect(formatClockLabel(8, 0)).toBe("8:00am");
    expect(formatClockLabel(8, 5)).not.toMatch(/Day/); // A69: never a day number (it stayed "Day 1" all week)
  });
});

function started(clockOn: boolean) {
  GameSessionAdapter.setTimeOfDayEnabled(clockOn);
  const sb = new GameSessionRegistry().sandboxFor(`cg-${Math.random()}`);
  const s = sb.session as GameSessionAdapter;
  s.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  s.setPerConversationClockEnabled(true);
  return s;
}
const prompt = (s: GameSessionAdapter): string => s.getMomentPrompt({}).systemPrompt;
const clockLine = (p: string): string | undefined => p.split("\n").find((l) => l.startsWith("- Clock: "));
const live = (s: GameSessionAdapter) => s.snapshot().live as unknown as { nightDepth?: number; dayNumber?: number; timeOfDay?: string };

describe("the moment prompt carries the exact engine clock", () => {
  it("while the day is running: the Clock line equals the engine clock and CHANGES as the clock moves", () => {
    const s = started(true);
    for (let i = 0; i < 80 && live(s).timeOfDay === undefined; i++) s.advanceGame(); // reach the day-break (the clock starts)
    expect(live(s).timeOfDay, "precondition: the clock is running").toBeDefined();
    const first = clockLine(prompt(s));
    expect(first, "a Clock line is present").toBeDefined();
    expect(first).toContain(formatClockLabel(live(s).nightDepth!, live(s).dayNumber ?? 1));

    s.advanceClockPerConversation(); s.advanceClockPerConversation(); // two messages = +10 minutes
    const second = clockLine(prompt(s));
    expect(second).toContain(formatClockLabel(live(s).nightDepth!, live(s).dayNumber ?? 1));
    expect(second, "the prompt's clock moved with the engine clock").not.toBe(first);
  });

  it("the line tells the narrator to name no other time", () => {
    const s = started(true);
    for (let i = 0; i < 80 && live(s).timeOfDay === undefined; i++) s.advanceGame();
    expect(clockLine(prompt(s))).toMatch(/never state any other clock time/);
  });

  it("clock dormant (the premiere, or the clock off): no Clock line at all - the prompt is unchanged", () => {
    expect(clockLine(prompt(started(false)))).toBeUndefined();
    const s = started(true);
    expect(live(s).timeOfDay, "the premiere has no clock yet").toBeUndefined();
    expect(clockLine(prompt(s))).toBeUndefined();
  });

  it("the clock label is public: no hidden-state words ride the Clock line", () => {
    const s = started(true);
    for (let i = 0; i < 80 && live(s).timeOfDay === undefined; i++) s.advanceGame();
    const line = clockLine(prompt(s))!;
    expect(line).not.toMatch(/trust|threat|affinity|secret|vault|hidden/i);
  });
});
