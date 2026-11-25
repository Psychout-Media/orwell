import { describe, it, expect } from "vitest";
import { playSeason } from "../support/whatFired/player";
import { firstSeedWhere } from "../support/firstSeedWhere";

/**
 * ORW-870 (bug scan B1-2): "dissent noticed" (0180 part 2: a houseguest who voted with the majority cools on someone they HEARD voted the other way) never fired in a played game. The week rolls as the eviction's
 * result lands, before the vote is talked about, so the record's week is one behind the clock and behind the week the rumors carry; the fold and the rumor reader both required the record's own week. The unit tests wrote the
 * record, the clock and the rumors by hand with equal weeks, so they passed while the live path could not produce the trigger. REAL PATH: a seeded season is played through the player channel (nothing hand-set); at least one
 * pair must have been noticed (the engine's own once-per-pair-per-week record). Fails before the fix (0 noticed on this season), passes after. HEAVY LANE (tests/uat/**).
 */
describe("ORW-870 REAL PATH: a dissenter the majority heard about is noticed", () => {
  it("a played season records at least one noticed dissent", async () => {
    // ORW-791 (re-pin, not a regression): the voted player now gets a Continue step after their own vote, so the played season moved and seed 6 no longer records a noticed dissent inside 700 messages. The seed is scanned (hint 1; seed 6 was the old pin) for the first season that does.
    const found = await firstSeedWhere(async (seed, sandbox) => {
      let noticed = 0;
      await playSeason({ user: sandbox, seed, maxMessages: 700, watch: async ({ sess }) => { noticed = (sess.snapshot()?.live?.dissentNoticed ?? []).length; return noticed > 0; } });
      return noticed > 0 ? noticed : undefined;
    }, { from: 1, to: 12, hint: 1, sandbox: (s) => `wf-${s}`, what: "a played season in which a houseguest cools on someone they heard dissented" });
    expect(found.at, "a houseguest cooled on someone they heard dissented").toBeGreaterThan(0);
  }, 900_000);
});
