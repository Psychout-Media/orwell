import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import { type Stop, playUntil } from "./playedSeason";

/**
 * ORW-746 (gap G4-7): the premiere's named arrivals, through the real loop. The season is played by the scripted talking player on the production runtime (the real orchestrator commits each
 * message; every layer at its shipped default), from the casting card to the end of the premiere. After EVERY message the player's own `premiereIntros` read is taken and the `justArrived` it
 * names is recorded. A houseguest who was never named on an arrival is one the player and the narrator never get to meet in order; one named twice is a repeated introduction (the Season 2 playtest
 * saw both: arrivals never shown, introductions repeated). Each houseguest is named exactly once, the player's own entrance names nobody, and the board counts match. Roles only.
 */
type Board = { entrance?: { stage: string; index: number; total: number; playerInside: boolean; justArrived?: { id: string; name: string }; arrivedNames: string[] } };
// By design the houseguests drawn BEFORE the player's slot are already inside when the player walks in (the board lists them in `arrivedNames`); every later houseguest arrives one per advance and is named by `justArrived`.

describe("the premiere names each arrival once, in a played season", () => {
  for (const seed of [3, 5, 7, 11]) {
    it(`seed ${seed}: every houseguest is named exactly once - already inside when the player walks in, or on one named arrival after`, async () => {
      const after: string[] = [];
      const indexes: number[] = [];
      let inside: string[] | null = null;
      const at = await playUntil(seed, async (s: Stop) => {
        const e = (s.sess.premiereIntros() as Board | null)?.entrance;
        if (e && inside === null) inside = [...e.arrivedNames]; // the first read: who was already inside before the staged arrivals began
        return !e || e.stage === "done"; // the board is gone once the premiere ends
      }, {
        user: `wf-746-${seed}`, maxMessages: 600,
        // a read-only observer on the session's own advance: after EVERY advance (not only after each message, which can batch several) record the arrival the board names
        setup: (sess: any) => {
          const advance = sess.advanceGame.bind(sess);
          sess.advanceGame = (...args: unknown[]) => {
            const view = advance(...args);
            const e = (sess.premiereIntros() as Board | null)?.entrance;
            if (e) {
              // an arrival is an advance that moved the inside count (the board keeps naming the latest arrival through the toast, which is not a new arrival)
              const prev = indexes.length ? indexes[indexes.length - 1]! : 0;
              if (e.index > prev && e.justArrived) after.push(e.justArrived.name);
              indexes.push(e.index);
            }
            return view;
          };
        },
      });
      const cast = ((at.sess.getGameState() as { house: Array<{ id: string; name: string }> }).house).filter((h) => h.id !== PLAYER).map((h) => h.name);
      expect(cast.length, "positive control: a full cast").toBeGreaterThan(10);
      expect(after.length, "positive control: the observer saw staged arrivals (the player is drawn late in some seasons, so only a few)").toBeGreaterThan(0);
      const named = [...(inside ?? []), ...after];
      expect(new Set(named).size, "no houseguest is named twice").toBe(named.length);
      expect([...named].sort(), "every houseguest is named exactly once").toEqual([...cast].sort());
      // the engine's own record: one "<name> arrives" premiere-entrance event per houseguest (the player's own entrance included), in arrival order - read from the event store the real loop wrote
      const events = at.engine.events.queryAll() as ReadonlyArray<{ content?: string; kind?: string; type?: string }>;
      const arrivals = events.map((e) => String(e.content ?? "")).filter((c) => / arrives$/.test(c));
      expect(arrivals.length, "positive control: arrival events were recorded").toBeGreaterThan(10);
      for (const name of [...cast, at.sess.getGameState().player.name as string]) expect(arrivals.filter((c) => c === `${name} arrives`), `${name} has exactly one arrival event`).toHaveLength(1);
      expect(after, "the player is never an arrival").not.toContain(at.sess.getGameState().player.name);
      for (let i = 1; i < indexes.length; i++) expect(indexes[i]! - indexes[i - 1]!, `advance ${i}: the inside count never jumps by more than one`).toBeLessThanOrEqual(1);
    }, 600_000);
  }
});
