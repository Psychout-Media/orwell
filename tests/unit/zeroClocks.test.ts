import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { clockBandFor, formatClockBandLabel, formatClockLabel, isEarlyMorning } from "../../src/engine/timeOfDay";

/**
 * ORW-377 (zero clocks in the house): the narrator is handed the part of the day, never a clock time. PRESENTATION ONLY: the engine clock, day schedule, sleep debt and bedtime logic are untouched
 * (Ryne: the game itself keeps its internal clock). Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

const CLOCK_TIME = /\b\d{1,2}:\d{2}\b|\b\d{1,2}\s?(?:am|pm)\b/i;

function started(seed = 7) {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const sb = new GameSessionRegistry().sandboxFor(`zc-${Math.random()}`);
  const s = sb.session as GameSessionAdapter;
  s.createCharacter({ playerName: "The Player", archetype: "floater", seed });
  s.setPerConversationClockEnabled(true);
  return s;
}
const live = (s: GameSessionAdapter) => s.snapshot().live as unknown as { nightDepth?: number; dayNumber?: number; timeOfDay?: string };
function runToClock(s: GameSessionAdapter) { for (let i = 0; i < 80 && live(s).timeOfDay === undefined; i++) s.advanceGame(); }

describe("the eight spoken bands", () => {
  it("map the engine clock hour to a part of the day (incl. past midnight)", () => {
    const cases: Array<[number, string]> = [[8, "morning"], [9.67, "morning"], [12, "midday"], [14, "afternoon"], [17, "evening"], [21, "night"], [24, "late night"], [25.99, "late night"], [26, "early morning"], [27.08, "early morning"], [30, "early morning"], [31.99, "early morning"], [32, "morning"]];
    for (const [h, b] of cases) expect(clockBandFor(h), String(h)).toBe(b);
    expect(formatClockBandLabel(27.08, 5)).toBe("early morning, Day 5");
    // review of #2657: the band is computed from the same whole minute the clock label shows, so they never disagree around a boundary (11:59:56 reads 12:00pm)
    expect(formatClockLabel(11.999, 1)).toBe("12:00pm, Day 1");
    expect(formatClockBandLabel(11.999, 1)).toBe(formatClockBandLabel(12, 1));
    expect(formatClockBandLabel(11.99, 1), "a real minute before the boundary is still the earlier band").toBe(formatClockBandLabel(11.9, 1));
    expect(formatClockBandLabel(25.999, 1)).toBe(formatClockBandLabel(26, 1));

    expect(isEarlyMorning(25.99)).toBe(false); expect(isEarlyMorning(1.99)).toBe(false); expect(isEarlyMorning(2)).toBe(true); expect(isEarlyMorning(4.9)).toBe(true); expect(isEarlyMorning(7.99)).toBe(true); expect(isEarlyMorning(8)).toBe(false); expect(isEarlyMorning(12)).toBe(false); expect(isEarlyMorning(26)).toBe(true); expect(isEarlyMorning(31.99)).toBe(true); expect(isEarlyMorning(32)).toBe(false); expect(isEarlyMorning(undefined)).toBe(false);
  });
});

describe("getMomentPrompt with zeroClocks", () => {
  it("hands the narrator the band and NO clock time at any hour; without the flag it is byte-identical to before", () => {
    const s = started();
    runToClock(s);
    expect(live(s).timeOfDay).toBeDefined();
    const seenBands = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const zc = s.getMomentPrompt({ zeroClocks: true }).systemPrompt;
      const off = s.getMomentPrompt({}).systemPrompt;
      const line = zc.split("\n").find((l) => l.startsWith("- Part of the day: "))!;
      expect(line).toBeDefined();
      seenBands.add(line.split(" (engine truth)")[0]!);
      // the only clock-looking text allowed is the quoted counter-examples in the rule itself
      expect(zc.split("\n").filter((l) => !l.startsWith("- Part of the day: ")).join("\n")).not.toMatch(CLOCK_TIME);
      expect(zc).not.toContain("- Clock: ");
      expect(off).toContain("- Clock: ");
      s.advanceClockPerConversation();
      s.advanceClockPerConversation();
    }
    expect(seenBands.size, "the band moves as the clock moves").toBeGreaterThan(1);
  });

  it("an explicit zeroClocks:false is byte-identical to leaving the flag off (the no-flag prompt is the pre-change prompt)", () => {
    const s = started();
    runToClock(s);
    for (let i = 0; i < 20; i++) {
      expect(s.getMomentPrompt({ zeroClocks: false }).systemPrompt).toBe(s.getMomentPrompt({}).systemPrompt);
      s.advanceClockPerConversation(); s.advanceClockPerConversation();
    }
    expect(s.getMomentPrompt({}).systemPrompt).toContain("- Clock: ");
  });

  it("is presentation only: with the setting ON vs OFF the engine clock, schedule, timeOfDay and event order are byte-identical", () => {
    const run = (zc: boolean) => {
      const s = started(11);
      const trace: unknown[] = [];
      for (let i = 0; i < 70; i++) {
        s.getMomentPrompt(zc ? { zeroClocks: true } : {}); // the narrator's read each step; must change nothing
        const r = i % 3 === 0 ? s.advanceGame() : (s.advanceClockPerConversation(), null);
        const v = s.getGameState() as unknown as Record<string, unknown>; // the public read (the adapter's `view()` is private)
        trace.push({ i, nd: live(s).nightDepth, day: live(s).dayNumber, tod: v.timeOfDay, label: v.clockLabel, ds: v.daySchedule, phase: v.phase, ev: r && (r as { event?: unknown }).event, held: r && (r as { held?: unknown }).held });
      }
      return JSON.stringify({ trace, snap: s.snapshot().live });
    };
    expect(run(true)).toBe(run(false));
  });
});

describe("ORW-392 - the HUD says Early morning past 2am, before the house's wake-up call", () => {
  it("the status carries earlyMorning from 2am to the wake-up call, on both clock scales", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    try {
      const s = new GameSessionRegistry().sandboxFor("early-morning").session as GameSessionAdapter & Record<string, any>;
      s.createCharacter({ playerName: "P", seed: 7 });
      s.setPerConversationClockEnabled(true);
      s.advanceGame(); const l = (s as any).live; // the live state itself (a TEST-ONLY seam, like tests/support/dayTwoMorning.ts)
      const at = (hour: number) => { l.timeOfDay = "late-night"; l.nightDepth = hour; return s.gameStatus() as any; };
      expect(at(24.5).earlyMorning, "half past midnight is still late night").toBeUndefined();
      expect(at(25.99).earlyMorning).toBeUndefined();
      expect(at(26).earlyMorning).toBe(true);
      expect(at(31.9).earlyMorning).toBe(true);
      expect((s.getGameState() as any).earlyMorning).toBe(true);
      // ORW-441: after an EARLY bed the player wakes at bed+8h on the 0-24 scale in the "morning" phase (4:55am = 4.9)
      l.timeOfDay = "morning"; l.nightDepth = 4.9;
      expect((s.gameStatus() as any).earlyMorning, "up at 4:55am after an early bed").toBe(true);
      expect((s.getGameState() as any).earlyMorning).toBe(true);
      l.nightDepth = 7.99; expect((s.gameStatus() as any).earlyMorning).toBe(true);
      l.nightDepth = 8; expect((s.gameStatus() as any).earlyMorning, "the house's wake-up call").toBeUndefined();
      l.nightDepth = 9;
      expect((s.gameStatus() as any).earlyMorning).toBeUndefined();
      expect((s.getGameState() as any).earlyMorning, "the game-state view drops it outside the band too").toBeUndefined();
    } finally { GameSessionAdapter.setTimeOfDayEnabled(null); }
  });
});
