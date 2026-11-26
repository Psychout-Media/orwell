import { describe, it, expect } from "vitest";
import { keepCredit } from "../../src/engine/voteTalk";
import { PLAYER } from "../../src/domain/ids";
import { playUntil, type Stop } from "./playedSeason";
import { firstSeedWhere } from "../support/firstSeedWhere";
import { watchVoteTalk, beliefOf, overclaims, type Talk } from "./voteTalkPlay";

/**
 * ORW-594 (Fable T2-13) + ORW-613: vote talk steers, a vote lie can be caught by the public count, and the player hears how people voted - in a PLAYED season (ORW-810: before,
 * the vote record, the bonds and the tellings were all set by hand). Each test stops at the first vote talk that shows what it needs, in the first seed that gets there
 * (ORW-880: scanned in a fixed order, the hints first):
 *  - from seed 3: the first eviction's vote talk (week 2) tells the player, and credits a believed keep;
 *  - from seed 17: a unanimous eviction (no keep votes), where a credited "I voted to keep them" is caught by the count at once and the credit is taken back.
 * The pure checks stay in tests/unit/voteTalkSteers.test.ts, with the two catches play has not reached (a catch BY COUNTING with keep votes left, and a keep claim told after the
 * count is public): forty seasons played to the crown (seeds 1-40 in the sandboxes wf-<seed>; ORW-829, 2026-11-24) never produced either, so those stay hand-set there
 * with a todo. Roles only.
 */
const firstTalk = async (hint: number | number[], wanted: (s: Stop, t: Talk) => boolean): Promise<{ at: Stop; talk: Talk }> =>
  (await firstSeedWhere(async (seed, sandbox) => {
    let hit: Talk | undefined;
    const at = await playUntil(seed, watchVoteTalk((s, t) => { if (wanted(s, t)) { hit = t; return true; } return false; }), { user: sandbox });
    return { at, talk: hit! };
  }, { from: 1, to: 30, hint, sandbox: (s) => `wf-${s}`, what: "the vote talk the test needs" })).at;

describe("vote talk in a played season", () => {
  it("the player is told how someone voted, as a scene they were in (never whether it is true)", async () => {
    const { at, talk } = await firstTalk([1, 3], (_s, t) => t.told.some((c) => c.listener === PLAYER));
    const toPlayer = talk.told.filter((c) => c.listener === PLAYER);
    for (const c of toPlayer) {
      const scene = at.engine.events.queryAll().find((e) => !e.hidden && e.type === "conversation" && e.witnessSet.includes(PLAYER) && e.witnessSet.includes(c.speaker) && /voted to keep/.test(String(e.content)));
      expect(scene, "the telling is a scene the player witnessed").toBeDefined();
      expect(String(scene!.content)).not.toMatch(/\b(true|false|lie|lying|truth)\b/i);
    }
    // the player's own view carries the scene, and nothing of the engine's claim bookkeeping
    const view = JSON.stringify(await at.call("getVisibleStateFor", { entity: "player" }));
    expect(view).toMatch(/voted to keep/);
    expect(view).not.toContain("voted-to-keep");
  }, 120_000);

  it("a believed keep earns credit exactly when the listener liked the one kept", async () => {
    const credited = (s: Stop, t: Talk) => t.told.some((c) => c.listener !== PLAYER && (beliefOf(s, c.listener, c.id)?.impact?.trust ?? 0) > 0);
    const { at, talk } = await firstTalk([1, 3], credited);
    let withCredit = 0;
    for (const c of talk.told.filter((x) => x.listener !== PLAYER)) {
      const b = beliefOf(at, c.listener, c.id);
      if (!b || b.refuted) continue; // not believed (or already caught): nothing to credit
      const likes = at.sess.rel.edge(c.listener, c.object!).affinity;
      const earned = (b.impact?.trust ?? 0) > 0;
      expect(earned, "credit iff the listener liked the one kept").toBe(keepCredit(likes) > 0);
      if (earned) {
        withCredit++;
        expect(b.impact!.trust!, "the credit is the keep credit for that liking (less only where trust was already near full)").toBeLessThanOrEqual(keepCredit(likes) + 1e-12);
      }
    }
    expect(withCredit).toBeGreaterThan(0);
  }, 120_000);

  it("a unanimous count catches every believed \"I voted to keep them\" at once, and a credit it earned is taken back", async () => {
    const caughtCredit = (s: Stop, t: Talk) => t.tally.keepVotes === 0 && t.told.some((c) => c.listener !== PLAYER && beliefOf(s, c.listener, c.id)?.refuted && (beliefOf(s, c.listener, c.id)?.impact?.trust ?? 0) > 0);
    const { at, talk } = await firstTalk([1, 17, 24], caughtCredit);
    // the count rules out every keep claim about the evictee from a voter: each one believed is now caught, with a lied-to-me in its listener
    for (const c of talk.told.filter((x) => x.listener !== PLAYER && x.object === talk.tally.evictee && talk.tally.voters.includes(x.subject))) {
      const b = beliefOf(at, c.listener, c.id);
      if (!b) continue;
      expect(b.refuted, "a claim the count rules out is caught").toBe(true);
      expect((at.sess.live.beliefs[c.listener] as Array<{ kind: string; subject: string }>).some((x) => x.kind === "lied-to-me" && x.subject === c.speaker)).toBe(true);
      if ((b.impact?.trust ?? 0) > 0) expect(at.sess.rel.edge(c.listener, c.speaker).trust, "the credit is taken back").toBeLessThan(talk.trustBefore(c.listener, c.speaker) + b.impact!.trust!);
    }
    expect(overclaims(at, talk).every((o) => o.caught.length === o.excess)).toBe(true);
  }, 600_000);
});
