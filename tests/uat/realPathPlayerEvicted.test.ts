import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import { isPreJuryEvictee, preJuryEvictionCount } from "../../src/engine/liveSeason";
import { renderHostBlock } from "../../src/engine/momentPrompts";
import { playUntil, wfScan, type Stop } from "../realpath/playedSeason";
import { firstSeedWhere } from "../support/firstSeedWhere";

/**
 * ORW-719: the PLAYER is voted out of a PLAYED game (ORW-813: before, the board was set by hand - the HOH chosen, the player put on the block - and sentinels planted in the hidden
 * layer). ORW-894: the seed is picked by a scan (a season where the house votes the player out; the old seed 16 is the hint), not pinned. (1) The two cards the player owes (their exit interview, then the
 * watch-or-skip choice) each appear exactly once, in that order, survive a save/restore, and the season then ends. (2) The houseguests' goodbyes are voiced from the speaker's REAL
 * public record with the player, and none of the hidden material the season holds rides with them. HEAVY LANE (tests/uat/**, the `real-path` leg). Roles only.
 */
const HINT_OUT = 16; // last seed known to vote the player out at the first eviction (the scan tries it first)
/** The first seed whose played season reaches the player's own goodbye night (the house voted the player out), with the game stopped there. */
// ORW-1007: a season whose pre-jury evictions are all over and did not take the player has nothing more to give this test, so the play stops there (instead of playing the whole season to its end, ~10 min per seed)
const pastPreJury = (s: Stop): boolean => { const l = s.sess.live as { evictionOrder: string[]; active: string[] }; return l.evictionOrder.length > preJuryEvictionCount(l); };
const evictedSeason = () => firstSeedWhere(async (seed) => { const at = await playUntil(seed, (s) => goodbyeNow(s) || pastPreJury(s), { user: `wf-${seed}`, maxMessages: 8000 }); return at && goodbyeNow(at) ? at : undefined; },
  { ...wfScan([HINT_OUT, 1, 2, 3, 4, 5], "a season where the house votes the player out before the jury forms"), to: 40, wide: { maxSeasons: 40, budgetMs: 3_000_000, reason: "ORW-1007: the house voting the player out BEFORE the jury forms is a rare outcome (the engine never protects the player); each season stops as soon as the pre-jury evictions pass without the player" } });
// ORW-1007: the spectator card (the second card) is only offered to a PRE-jury evictee, so the scan requires a pre-jury eviction (a jury-stage eviction of the player has no such card)
const goodbyeNow = (s: Stop): boolean => { const ev = s.sess.getGameState().eviction; return ev?.stage === "goodbye" && ev.evictee?.id === PLAYER && isPreJuryEvictee(s.sess.live, PLAYER); };
const hiddenOf = (s: Stop): string[] => [
  ...s.engine.events.queryAll().filter((e) => e.hidden && !e.witnessSet.includes(PLAYER)).map((e) => String(e.content)),
  ...s.engine.vault.readHidden().map((r) => r.content),
].filter((c) => c.trim().length >= 12);

describe("ORW-719 - the evicted player's own cards (played)", () => {
  it("raises the exit interview then the watch-or-skip choice, each exactly once, surviving a save/restore at each, and the season then ends with no further card for the player", async () => {
    const seen: string[] = []; let restoredSame = true; let after: string[] = [];
    const { seed: SEED_OUT } = await evictedSeason();
    const at = await playUntil(SEED_OUT, (s) => !!s.sess.getGameState().finished, { user: `wf-${SEED_OUT}`,
      maxMessages: 8000,
      decide: (p, sess) => {
        if (seen.includes("spectator-choice")) { after.push(p.kind); return undefined; }
        if (p.kind !== "exit-interview" && p.kind !== "spectator-choice") return undefined;
        seen.push(p.kind);
        sess.restore(JSON.parse(JSON.stringify(sess.snapshot()))); // a save/restore at the card: the same card, not a second
        if (sess.getGameState().pending?.kind !== p.kind) restoredSame = false;
        return p.kind === "exit-interview" ? { kind: "exit-interview", vote: p.stances?.[0] ?? p.options?.[0]?.id, statement: "I gave it everything." } : { kind: "spectator-choice", vote: "skip" };
      },
    });
    expect(seen).toEqual(["exit-interview", "spectator-choice"]);
    expect(restoredSame, "a restore at a card keeps the same card").toBe(true);
    expect(after.filter((k) => k === "exit-interview" || k === "spectator-choice"), "no further card for the player's eviction").toEqual([]);
    expect(at.sess.getGameState().finished).toBe(true);
  }, 3_600_000);
});

describe("ORW-719 - the goodbyes are voiced from the speaker's real record with the player (played)", () => {
  it("hands each speaker's public record (facts only), the rule rides the eviction moment, and none of the hidden material the season holds is in it", async () => {
    const { at } = await evictedSeason();
    const ev = at.sess.getGameState().eviction;
    const goodbyes = ev.host.goodbyes as Array<{ speaker: string; record: string[] }>;
    expect(goodbyes.length).toBeGreaterThan(0);
    for (const g of goodbyes) { expect(g.record.length).toBeGreaterThan(0); expect(g.speaker).not.toMatch(/npc:/); }
    const block = renderHostBlock(at.sess.getGameState()).join("\n");
    expect(block).toContain("The house's goodbyes to the player");
    for (const g of goodbyes) expect(block).toContain(g.speaker);
    const moment = JSON.stringify(at.sess.getMomentPrompt({}));
    expect(moment).toContain("GOODBYES TO THE PLAYER");
    const hidden = hiddenOf(at);
    expect(hidden.length, "non-vacuous: the season holds hidden material").toBeGreaterThan(5);
    for (const x of hidden) { expect(JSON.stringify(ev.host)).not.toContain(x); expect(moment).not.toContain(x); }
  }, 3_600_000);
});
