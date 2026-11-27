import { describe, it, expect } from "vitest";
import { playedGame } from "../support/playedGame";

/**
 * ORW-920 (Ryne's ruling): a STATED wait ("for two hours", "until 9pm") is interrupted ONLY when something is actually due: a ceremony or comp call (event-due), bedtime, or a houseguest whose
 * own want has come due (an npc-approach carrying its desire). No per-beat dice: no random production pull, no random sighting, no flat approach roll. REAL PATH: a played season, the stated
 * wait through the player's lever, several seeds and several waits each; the flat approach roll is the live path with the desire clock off, so it is switched off here to prove the roll is gone
 * (with the desire clock on, an approach is a real reason and may stop the wait). Roles only.
 */
type Live = { nightDepth?: number; dayNumber?: number; timeOfDay?: string };
const DUE = new Set(["max-beats", "event-due", "bedtime"]);

describe("a stated wait is cut short only by something due (played)", () => {
  it("never stopped by a random pull, sighting or flat approach roll, across seeds and waits", () => {
    let waits = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      // not as shipped: the desire clock is off so the old flat approach roll is the live path and its absence is provable (with it on, an approach is a real reason)
      const g = playedGame({ seed, user: `swd-${seed}`, before: (s) => { s.setDesireClockEnabled(false); } });
      const live = (): Live => (g.s.snapshot() as unknown as { live: Live }).live;
      g.playUntil(() => (live().dayNumber ?? 1) >= 2 && live().timeOfDay === "evening" && (live().nightDepth ?? 0) >= 18.5 && (live().nightDepth ?? 0) < 19.5, 4000, "an early evening of day 2+");
      for (let i = 0; i < 3; i++) {
        const r = g.s.hangOut({ maxMinutes: 60 } as never);
        if (!r.ok) break;
        waits++;
        expect(DUE.has(r.stopReason ?? ""), `seed ${seed} wait ${i}: stopped by ${r.stopReason}`).toBe(true);
        if (r.stopReason === "bedtime") break;
      }
    }
    expect(waits, "the waits ran").toBeGreaterThan(20);
  });
});
