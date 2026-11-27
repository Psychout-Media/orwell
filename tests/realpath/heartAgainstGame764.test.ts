import { describe, it, expect } from "vitest";
import { type Stop, firstStop } from "./playedSeason";

/**
 * ORW-764 (from ORW-736): "heart against game" (spec 0207) through the real writers. The old live test (tests/unit/showmanceHeartBreakup.test.ts) sets the bonds by hand. Here the season is PLAYED (the scripted talking
 * player on the production runtime): houseguests flirt and spend days together in house life until a showmance is real, an alliance forms, an HOH puts the showmancer's partner on the block, and an eviction vote runs.
 * The stop is the first moment a voter has been SHAKEN by it (the engine's own once-per-voter-partner-week note, `heart:<week>:<voter>:<partner>`); the test then reads what the fold did. Nothing is set by hand. Roles only.
 */
type Live = {
  romances?: Record<string, number>; breakups?: string[]; feelingsSeen?: string[]; hoh?: string | null; nominees?: string[];
  voteRecord?: Array<{ week: number; evictee: string; voteOf: Record<string, string> }>;
  bonds?: Record<string, { strain?: number; romance?: number }>;
};
const shaken = (live: Live): string[] => (live.feelingsSeen ?? []).filter((k) => k.startsWith("heart:"));

describe("heart against game, in a played season", () => {
  it("a voter whose showmance partner sat on the block while their alliance wanted them out is shaken, and the bond fold records it", async () => {
    const at = await firstStop((s: Stop) => shaken(s.sess.live as Live).length > 0, { from: 1, to: 16, hint: [2, 1], sandbox: (x) => `h764-${x}`, what: "a voter shaken by heart against game" }, { maxMessages: 1500 });
    const live = at.sess.live as Live;
    const keys = shaken(live);
    for (const k of keys) {
      const m = /^heart:(\d+):(npc:\d+):(npc:\d+|player)$/.exec(k); // ids carry a colon of their own
      expect(m, `a well-formed shaken key: ${k}`).not.toBeNull();
      const [, week, voter, partner] = m as unknown as [string, string, string, string];
      const pair = [voter, partner].sort().join("|");
      expect(live.romances?.[pair], "their showmance was real in the house").toBeDefined();
      expect((live.breakups ?? []).includes(pair), "and it had not already ended").toBe(false);
      const vote = (live.voteRecord ?? []).find((v) => String(v.week) === week && (v.voteOf[voter] !== undefined));
      expect(vote, "the voter voted that week").toBeDefined();
      // the fold left a mark: the voter's bond toward their partner (the heart lost) or toward the HOH whose block it was (the heart won) carries strain
      const strain = (a: string, b: string): number => live.bonds?.[`${a}|${b}`]?.strain ?? 0;
      const marked = strain(voter, partner) > 0 || (live.hoh ? strain(voter, live.hoh) > 0 : false);
      expect(marked, "the shaken voter carries strain in a bond").toBe(true);
    }
    expect(keys.length, "positive control").toBeGreaterThan(0);
  }, 1_800_000);
});
