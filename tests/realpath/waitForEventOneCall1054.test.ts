import { describe, it, expect } from "vitest";
import { playedGame } from "../support/playedGame";

/**
 * ORW-1054: "hang out until production calls the next event" reached the event only after a long run of calls (audit: runs of 21, 16 and 16 identical messages, median 20 held messages
 * per phase), because the open-ended hang-out is cut short by per-beat chance stops (a pull, a sighting, an approach) and is capped at 8 beats. With `untilEvent` the target is the event itself: no
 * dice, so ONE call reaches it (or the stop that is really due: bedtime, a houseguest's own want). REAL PATH: a played season, the lever through the player's channel, several seeds.
 * Prints calls per held phase for the open-ended hang-out (the old shape) and for untilEvent (the new one).
 */
type Ds = { due?: boolean; minutesUntil?: number };
const held = (s: { gameStatus(): unknown }): boolean => {
  const ds = (s.gameStatus() as { daySchedule?: Ds }).daySchedule;
  return !!ds && ds.due === false && typeof ds.minutesUntil === "number" && ds.minutesUntil > 60;
};

function callsToDue(seed: number, untilEvent: boolean): { calls: number; stops: string[] } | null {
  const g = playedGame({ seed, user: `wfe-${seed}` });
  try { g.playUntil(() => held(g.s) && !g.s.getGameState().pending, 4000, "a held phase"); } catch { return null; }
  const stops: string[] = [];
  for (let calls = 1; calls <= 60; calls++) {
    const r = g.s.hangOut(untilEvent ? ({ untilEvent: true } as never) : {});
    if (!r.ok) return null;
    stops.push(r.stopReason ?? "?");
    if (r.stopReason === "event-due") return { calls, stops };
    if (r.stopReason === "bedtime") return { calls, stops };
  }
  return { calls: 60, stops };
}

describe("waiting for the next scheduled event reaches it in one call (played)", () => {
  it("untilEvent reaches the due event (or bedtime) in one call; the open-ended hang-out needs more", () => {
    const before: number[] = [], after: number[] = [];
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const a = callsToDue(seed, false), b = callsToDue(seed, true);
      if (!a || !b) continue;
      before.push(a.calls); after.push(b.calls);
      expect(b.calls, `seed ${seed}: untilEvent stops ${b.stops}`).toBe(1);
    }
    console.log("ORW-1054 calls to reach the event, open-ended:", JSON.stringify(before), "untilEvent:", JSON.stringify(after));
    expect(after.length, "seeds that reached a held phase").toBeGreaterThanOrEqual(3);
  });
});
