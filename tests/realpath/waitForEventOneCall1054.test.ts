import { describe, it, expect } from "vitest";
import { playedGame } from "../support/playedGame";

/**
 * ORW-1054: "hang out until production calls the next event" reached the event only after a long run of calls (audit: runs of 21, 16 and 16 identical messages, median 20 held messages
 * per phase), because the open-ended hang-out is cut short by per-beat chance stops (a pull, a sighting, an approach) and is capped at 8 beats. With `untilEvent` the target is the event itself: no
 * dice, so ONE call reaches it (or the stop that is really due: bedtime, a houseguest's own want). REAL PATH: a played season, the lever through the player's channel, several seeds.
 * Prints calls per held phase for the open-ended hang-out (the old shape) and for untilEvent (the new one).
 */
/** Plays the season the way playedGame.turn does, but stops at the first advance the schedule holds (reason "schedule"), before any hang-out. */
function playToHeld(seed: number): ReturnType<typeof playedGame> | null {
  const g = playedGame({ seed, user: `wfe-${seed}` });
  let msg = 0, playing = false;
  for (let i = 0; i < 1500; i++) {
    if (playing) g.s.noteMessage({ messageId: `m-${msg++}` });
    const v = g.s.advanceGame();
    if (!playing && v.started && v.status?.phase !== "premiere") { g.s.noteMessage({ messageId: `m-${msg++}` }); playing = true; }
    if (v.finished) return null;
    if (v.pending) { const req = g.answer(v.pending); if (req) g.s.submitDecision(req); continue; }
    if (v.held) {
      if (v.held.reason === "schedule" && (v.held.minutesUntil ?? 0) > 60) { console.log("held", seed, v.held.next, v.held.minutesUntil); return g; }
      if (v.held.reason === "schedule") { const h = g.s.hangOut(); if (!h.ok) g.s.turnIn(); } else g.s.turnIn();
    }
  }
  return null;
}

function callsToDue(seed: number, untilEvent: boolean): { calls: number; stops: string[] } | null {
  const g = playToHeld(seed);
  if (!g) return null;
  const stops: string[] = [];
  for (let calls = 1; calls <= 60; calls++) {
    const r = g.s.hangOut(untilEvent ? ({ untilEvent: true } as never) : {});
    if (!r.ok) return null;
    stops.push(`${r.stopReason}:${r.minutes}m/${r.beats}b`);
    if (r.stopReason === "event-due" || r.stopReason === "bedtime") return { calls, stops };
  }
  return { calls: 60, stops };
}

describe("waiting for the next scheduled event reaches it in one call (played)", () => {
  it("untilEvent reaches the due event (or bedtime) in one call; the open-ended hang-out needs more", () => {
    const before: number[] = [], after: number[] = [];
    for (const seed of [1, 2, 3]) {
      const a = callsToDue(seed, false), b = callsToDue(seed, true);
      if (!a || !b) continue;
      before.push(a.calls); after.push(b.calls);
      expect(b.calls, `seed ${seed}: untilEvent stops ${b.stops}`).toBe(1);
    }
    console.log("ORW-1054 calls to reach the event, open-ended:", JSON.stringify(before), "untilEvent:", JSON.stringify(after));
    expect(after.length, "seeds that reached a held phase").toBeGreaterThanOrEqual(2);
  });
});
