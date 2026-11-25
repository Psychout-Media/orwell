import { describe, it, expect } from "vitest";
import { playSeason } from "../support/whatFired/player";

/**
 * ORW-778: the scripted talking player used to be voted out in weeks 2 to 5 in every seed that finished, so the late phase (week 9 on) had no player-in scenes. The script now plays to stay, with the levers a person has: it answers the
 * offers made to it (a deal, an alliance pitch), makes its case to the sitting HOH in the short window before nominations, lobbies the veto holder / HOH / voters when on the block, uses the veto on itself, and nominates and votes
 * outside its own alliances and deals. It leaves the risky moves (deals, fights, accusations, using secrets) to the late game (`HOSTILE_FROM_WEEK`).
 * REAL PATH: played through the player channel, nothing hand-set. Each seed below saw the player evicted at the named week before the change (weeks 5 and 4). HEAVY LANE (tests/uat/**).
 * The engine's social game is still free to vote the player out later: this proves the script lasts past the early weeks, not that it can never lose.
 */
// QUARANTINED (ORW-702): a one-seed week-7 coin flip (the player is still in at week 7 on seeds 5 and 7); red on unrelated PRs whenever the played spine moves. ORW-702 slice 1 (#3200) deletes this file for good.
describe.skip("ORW-778 REAL PATH: the scripted player plays on past the early weeks", () => {
  for (const [seed, oldWeek] of [[5, 5], [7, 4]] as const) {
    it(`the player on a seed that voted it out in week ${oldWeek} is still in the house when the game reaches week 7`, async () => {
      const r = await playSeason({ seed, user: `wf-${seed}`, maxMessages: 4000, survive: true, watch: async ({ sess }) => (sess.live?.week ?? 0) >= 7 || !!sess.live?.evictionOrder?.includes(sess.house.player.id) });
      expect(r.crashes, "no crash out of a load-bearing tool").toEqual([]);
      expect(r.playerOutWeek ?? Infinity, "the player was not voted out before week 7").toBeGreaterThanOrEqual(7);
      expect(r.week).toBeGreaterThanOrEqual(7);
    }, 1_800_000);
  }
});
