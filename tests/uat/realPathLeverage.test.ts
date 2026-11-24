import { describe, it, expect } from "vitest";
import { playSeason } from "../support/whatFired/player";
import { firstSeedWhere } from "../support/firstSeedWhere";

/**
 * ORW-754 (741b): a LEVERAGE PLAY on a REAL secret in a PLAYED season. ORW-691 / spec 0202: a houseguest who holds a fact about someone else may press it (a blunt demand or a hint). The existing
 * tests (tests/unit/leveragePlay.test.ts) seed the state by hand. Here the season is played through the player channel by the scripted talking player of the nightly report (no model, seeded); the
 * play must be one a HOUSEGUEST made (not the player's own sneaky trade), on a fact that is really in that houseguest's knowledge about the person the play is aimed at (not a bluff).
 * The flag-off run plays the same seed with the feature switched off (the session's setter, the same switch ORWELL_LEVERAGE_PLAYS sets) past the on run's first play and reaches none.
 * HEAVY LANE (tests/uat/**, the `real-path` leg): about a minute of play on the runner per run, two runs.
 */
const MARGIN = 200;
interface Play { id: string; holder: string; target: string; factKey: string; status: string; manner: string }
const realPlay = (sess: any, engine: any): Play | undefined =>
  (sess.live?.leveragePlays as Play[] | undefined)?.find((p) => p.holder !== "player" && !p.factKey.startsWith("bluff:")
    && engine.knowledge.knownTo(p.holder).some((k: { factId?: string; id: string; subject?: string }) => (k.factId ?? k.id) === p.factKey && k.subject === p.target));
describe("ORW-754 REAL PATH: leverage on a real secret", () => {
  it("REAL PATH: a houseguest presses a real secret in a played season, and does not when ORWELL_LEVERAGE_PLAYS is off", async () => {
    let viewJson = "", hiddenSeen = true, found: Play | undefined;
    // ORW-880: the first seed from 3 whose season reaches it (the scan fails, naming every seed, if none in range does)
    const { seed, sandbox, at: on } = await firstSeedWhere(async (seed, sandbox) => {
      const on = await playSeason({ user: sandbox,
        seed, maxMessages: 1500,
        watch: ({ sess, engine }) => { found = realPlay(sess, engine); return !!found; },
        after: async ({ call }) => { const v = await call("getVisibleStateFor", { entity: "player" }); viewJson = JSON.stringify(v); hiddenSeen = (v.visibleEvents as Array<{ hidden: boolean }>).some((e) => e.hidden); },
      });
      return on.stopped === "watched" ? on : undefined;
    }, { from: 1, to: 12, hint: 3, sandbox: (s) => `wf-${s}`, what: "the on run reached a play on a real secret" });
    expect(found!.manner).toMatch(/^(blunt|sneaky)/);
    expect(on.milestones["state.leveragePlays"]).toBeGreaterThanOrEqual(1);
    // the player's own view (Vault wall) carries neither the play record nor the fact's lineage key, and no hidden event
    expect(hiddenSeen).toBe(false);
    expect(viewJson).not.toContain(found!.factKey);
    expect(viewJson).not.toContain("leveragePlays");

    const off = await playSeason({ user: sandbox,
      seed, maxMessages: on.messages + MARGIN,
      setup: (sess) => sess.setLeveragePlaysEnabled(false), // not as shipped: the flag-off run proves the play is the feature
      watch: ({ sess }) => (sess.live?.leveragePlays?.length ?? 0) > 0,
    });
    expect(off.stopped, "the off run played past the on run's play without one").toBe("cap");
    expect(off.messages).toBeGreaterThan(on.messages);
    expect(off.milestones["state.leveragePlays"]).toBeUndefined();
  }, 600_000);
});
