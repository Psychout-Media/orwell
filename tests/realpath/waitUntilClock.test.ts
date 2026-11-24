import { describe, it, expect } from "vitest";
import { playedGame } from "../support/playedGame";

/**
 * ORW-734a (playtest: a wait stated as a clock time moved the clock somewhere else, and the narrator was told an hour count that matched nothing). REAL PATH: a season is played through
 * the player's levers to an evening of a later day; then "wait until <clock time>" goes through `hangOut({ untilClock })` and the clock is read before and after. The engine owns the
 * clock: the wait ends AT that time (never past it, never a day later) unless an interruption cuts it short, and the minutes the engine reports are exactly the clock's own movement.
 * The 3 h cap on a player-stated wait stays. Roles only.
 */
type Live = { nightDepth?: number; dayNumber?: number; timeOfDay?: string };
const fmt = (h: number): string => `${Math.floor(h % 24)}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;

/** `quiet`: the approach and observation sources that interrupt a wait are switched off (a flag switch, as tests/unit/hangOutLever.test.ts does), so the wait can run to its stated time. */
function evening(seed: number, user: string, quiet = false) {
  // not as shipped: the approach and observation sources that interrupt a wait are off so the wait can run to its stated time (the same switches tests/unit/hangOutLever.test.ts turns off)
  const g = playedGame({ seed, user: user, before: quiet ? (s) => { s.setDesireClockEnabled(false); s.setWantMovementEnabled(false); s.setMorningApproachEnabled(false); s.setMoodApproachEnabled(false); s.setApproachMemoryEnabled(false); s.setNpcTellsEnabled(false); } : undefined });
  const live = (): Live => (g.s.snapshot() as unknown as { live: Live }).live;
  g.playUntil(() => (live().dayNumber ?? 1) >= 2 && live().timeOfDay === "evening" && (live().nightDepth ?? 0) >= 19 && (live().nightDepth ?? 0) < 20, 4000, "an evening of day 2+");
  return { g, live };
}

describe("wait until a clock time (hangOut untilClock), played", () => {
  it("moves the clock to that time, no further, and reports exactly the minutes it moved", () => {
    let reached = 0;
    for (const seed of [3, 5, 8, 11]) {
      const { g, live } = evening(seed, `wuc-${seed}`, true);
      const h0 = live().nightDepth!;
      const want = (20.5 - h0) * 60; // until 8:30pm, under the 3 h cap
      const r = g.s.hangOut({ untilClock: 20.5 } as never);
      const moved = (live().nightDepth! - h0) * 60;
      expect(r.ok).toBe(true);
      expect(Math.abs(moved - r.minutes), `seed ${seed}: engine says ${r.minutes} min, clock moved ${moved.toFixed(1)}`).toBeLessThan(1);
      expect(live().nightDepth!, `seed ${seed}: never past the stated time (${fmt(live().nightDepth!)})`).toBeLessThanOrEqual(20.5 + 1e-6);
      if (r.stopReason === "max-beats") { expect(Math.abs(moved - want), `seed ${seed}: an uninterrupted wait ends on the time`).toBeLessThan(1); reached++; }
    }
    expect(reached, "at least one seed ran the wait to its time").toBeGreaterThan(0);
  });

  it("a time that already passed today waits nothing (never a day later)", () => {
    const { g, live } = evening(3, "wuc-past");
    const h0 = live().nightDepth!;
    const r = g.s.hangOut({ untilClock: 18 } as never); // 6pm, long gone
    expect(r.ok).toBe(true);
    expect(r.minutes).toBe(0);
    expect(live().nightDepth).toBe(h0);
  });

  it("a stated minutes target and a stated clock time: the nearer one wins", () => {
    const { g, live } = evening(3, "wuc-both");
    const h0 = live().nightDepth!;
    const r = g.s.hangOut({ untilClock: 22, maxMinutes: 30 } as never);
    expect(r.minutes).toBeLessThanOrEqual(30);
    expect((live().nightDepth! - h0) * 60).toBeLessThanOrEqual(30.01);
  });

  it("goes through the MCP boundary: untilClock is accepted, and a bad hour is refused before any change", async () => {
    const { g, live } = evening(3, "wuc-mcp", true);
    const h0 = live().nightDepth!;
    const call = (a: Record<string, unknown>): Promise<{ ok?: boolean; minutes?: number }> => g.sb.mcp.player.callTool("hangOut", a) as never;
    await expect(call({ untilClock: 25 })).rejects.toThrow(/untilClock/);
    await expect(call({ untilClock: "10pm" })).rejects.toThrow(/untilClock/);
    expect(live().nightDepth).toBe(h0);
    const r = await call({ untilClock: 20.5 });
    expect(r.ok).toBe(true);
    expect(Math.abs((live().nightDepth! - h0) * 60 - (r.minutes ?? -1))).toBeLessThan(1);
  });

  it("sleep after the wait follows the wake rule: wake = min(8am, bed + 8h), so a bed at the stated time wakes eight hours on", () => {
    const { g, live } = evening(3, "wuc-sleep", true);
    const r = g.s.hangOut({ untilClock: 20.5 } as never);
    const bed = live().nightDepth!;
    expect(r.ok).toBe(true);
    const v = g.s.turnIn();
    expect(v.held, "past the start of the night a goodnight is taken").toBeUndefined();
    const wake = live().nightDepth!; // an early wake reads 0..8
    expect(wake, `bed ${fmt(bed)} woke ${fmt(wake)}`).toBeCloseTo(Math.min(8, bed - 16), 1);
  });
});
