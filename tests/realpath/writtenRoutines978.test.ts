import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import { type Stop, playUntil } from "./playedSeason";

/**
 * ORW-978 / spec 0209: routines written by the model from a houseguest's whole profile reach play. In a PLAYED season (the scripted talking player on the production runtime), the front end's write-back
 * (`recordNpcTraits` with a `routines` list, through the player channel, as the front end sends it) lands, and when that houseguest's house life runs, their routines include the written one with its own
 * words, ahead of the floor; a houseguest nothing was written for keeps the engine's floor. Nothing is set by hand but the write-back itself. Roles only.
 */
const WORDS = "keeps the first pot of coffee going for whoever is up, a habit from years of early shifts";
type Routine = { slot: string; place: string; action: string; source: string; gist?: string };

describe("a written routine reaches play", () => {
  it("the written routine is in the houseguest's routines, authored and first; another houseguest keeps the floor", async () => {
    let target: string | undefined;
    let other: string | undefined;
    let written = false;
    const at = await playUntil(5, async (s: Stop) => {
      const routines = (s.sess.live?.routines ?? {}) as Record<string, Routine[]>;
      if (!written) {
        const npcs = (s.sess.livingIds() as string[]).filter((i) => i !== PLAYER);
        // a houseguest whose routines have not been composed yet, so the written ones are the first the engine sees; and one to compare
        const fresh = npcs.filter((i) => !routines[i]);
        if (fresh.length < 2) return false;
        [target, other] = [fresh[0], fresh[1]];
        const res = await s.call("recordNpcTraits", { traits: [{ id: target, habits: ["gym-rat", "early-riser"], routines: [{ slot: "morning", place: "kitchen", action: "cook", company: "alone", strength: 0.9, gist: WORDS }] }] });
        expect(res.accepted, "the write-back landed").toBe(1);
        written = true;
        return false;
      }
      return !!routines[target!] && !!routines[other!];
    }, { user: "wf-978-5", maxMessages: 600 });
    const routines = (at.sess.live?.routines ?? {}) as Record<string, Routine[]>;
    const mine = routines[target!]!;
    expect(mine[0], "the written routine leads").toMatchObject({ slot: "morning", place: "kitchen", action: "cook", source: "authored", gist: WORDS });
    expect(mine.length, "the written one plus the two mapped habits").toBe(3);
    expect(routines[other!]!.every((r) => r.source === "floor"), "nothing was written for this one: the floor stands").toBe(true);
  }, 900_000);
});
