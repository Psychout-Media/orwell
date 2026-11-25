import { describe, it, expect } from "vitest";
import { playedGame } from "../support/playedGame";
import { firstSeedWhereSync } from "../support/firstSeedWhere";

/**
 * ORW-911 (Fable's week-1 playtest: "I wait until 9am" / "until 1pm" from an early-morning wake moved the clock about 5 minutes while the house slept): `hangOut({ untilClock })` read an early-morning
 * clock (the player up before the house, 0..8) as the small hours of the day before, so every target AFTER the house's wake-up call fell past the day's end and waited nothing.
 * REAL PATH: a season is played through the player's levers (bedtimes through the same `turnIn` the front end calls) until the player is up before the house; then "wait until 9am" goes through
 * the lever and the clock is read before and after. The seed is scanned (ORW-880) for a season where the player wakes before the house. Roles only. HEAVY LANE (tests/realpath).
 */
type Live = { nightDepth?: number; dayNumber?: number; timeOfDay?: string; wakeHour?: number };

describe("wait until a clock time from an early-morning wake, played", () => {
  it("a time after the house's wake-up call moves the clock toward it (the house sleeps, so nothing cuts it short), never past it", () => {
    const found = firstSeedWhereSync((seed, sandbox) => {
      const g = playedGame({ seed, user: sandbox });
      const live = (): Live => (g.s.snapshot() as unknown as { live: Live }).live;
      g.playUntil(() => (live().dayNumber ?? 1) >= 2 && (live().nightDepth ?? 99) < 7.5 && (live().nightDepth ?? 0) > 1 && !g.s.snapshot().live?.pending, 6000, "an early-morning wake");
      return { g, live };
    }, { from: 1, to: 12, hint: 3, sandbox: (seed) => `wf-${seed}`, what: "a season where the player is up before the house" });
    const { g, live } = found.at;
    const h0 = live().nightDepth!;
    const r = g.s.hangOut({ untilClock: 9 } as never);
    const h1 = live().nightDepth!;
    expect(r.ok, "the wait ran").toBe(true);
    expect(r.minutes, `from ${h0} to 9am: the clock moved (it moved nothing before ORW-911)`).toBeGreaterThan(0);
    expect(h1, "the clock moved forward").toBeGreaterThan(h0);
    expect(h1, "never past the stated time").toBeLessThanOrEqual(9 + 1e-6);
    expect(Math.abs((h1 - h0) * 60 - r.minutes), "the engine reports the clock's own movement").toBeLessThan(1);
  }, 1_200_000);
});
