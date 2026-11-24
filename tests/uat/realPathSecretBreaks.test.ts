import { describe, it, expect } from "vitest";
import { playSeason } from "../support/whatFired/player";
import { firstSeedWhere } from "../support/firstSeedWhere";

/**
 * ORW-753 (741a): a secret BREAKS in a PLAYED season. ORW-647 (spec 0204): once a day, a fact about a houseguest that enough of the others hold stops being a secret and comes out in front of the room.
 * Before this, whether it ever happens in play lived only in an opt-in report (tests/calibration/secretSubjectReport.test.ts). Here the season is played through the player channel by the scripted talking
 * player of the nightly report (tests/support/whatFired/player.ts; no model, seeded): nothing is hand-set, the assertions read what the engine recorded and what the player's own view carries.
 * The flag-off run plays the same seed with the feature switched off (the session's own setter, the same switch ORWELL_SECRET_BREAKS sets) for the same number of messages plus a margin, and reaches none.
 * HEAVY LANE (tests/uat/**, the `real-path` leg): about a minute of play on the runner per run, two runs.
 */
const MARGIN = 200; // the off run plays this many messages PAST where the on run broke a secret
describe("ORW-753 REAL PATH: secret breaks", () => {
  it("REAL PATH: a secret breaks in a played season, comes out as a public house event, and is off when ORWELL_SECRET_BREAKS is off", async () => {
    let viewJson = "", hiddenSeen = true;
    // ORW-880: the first seed from 3 whose season reaches it (the scan fails, naming every seed, if none in range does)
    const { seed, sandbox, at: on } = await firstSeedWhere(async (seed, sandbox) => {
      const on = await playSeason({ user: sandbox,
        seed, maxMessages: 1500,
        watch: ({ sess }) => (sess.live?.secretBreaks?.length ?? 0) > 0,
        after: async ({ call }) => { const v = await call("getVisibleStateFor", { entity: "player" }); viewJson = JSON.stringify(v); hiddenSeen = (v.visibleEvents as Array<{ hidden: boolean }>).some((e) => e.hidden); },
      });
      return on.stopped === "watched" ? on : undefined;
    }, { from: 1, to: 12, hint: 3, sandbox: (s) => `wf-${s}`, what: "the on run reached a break" });
    expect(on.milestones["state.secretBreaks"]).toBeGreaterThanOrEqual(1);
    expect(on.eventTypes["secret-break"], "the break was recorded as an event").toBeGreaterThanOrEqual(1);
    // the player's own view (Vault wall): no engine bookkeeping, and no hidden event among what they can see
    expect(hiddenSeen).toBe(false);
    expect(viewJson).not.toContain("secretBreaks");

    const off = await playSeason({ user: sandbox,
      seed, maxMessages: on.messages + MARGIN,
      setup: (sess) => sess.setSecretBreaksEnabled(false), // not as shipped: the flag-off run proves the break is the feature
      watch: ({ sess }) => (sess.live?.secretBreaks?.length ?? 0) > 0,
    });
    expect(off.stopped, "the off run played past the on run's break without one").toBe("cap");
    expect(off.messages).toBeGreaterThan(on.messages);
    expect(off.milestones["state.secretBreaks"]).toBeUndefined();
    expect(off.eventTypes["secret-break"]).toBeUndefined();
  }, 600_000);
});
