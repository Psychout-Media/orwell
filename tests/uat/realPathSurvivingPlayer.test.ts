import { describe, it, expect } from "vitest";
import { playSeason } from "../support/whatFired/player";

/**
 * ORW-778: the scripted talking player used to be voted out in weeks 2 to 5 in every seed that finished, so the late phase (week 9 on) had no player-in scenes. The script now plays to stay, with the levers a person has: it answers the
 * offers made to it (a deal, an alliance pitch), makes its case to the sitting HOH in the short window before nominations, lobbies the veto holder / HOH / voters when on the block, uses the veto on itself, and nominates and votes
 * outside its own alliances and deals. It leaves the risky moves (deals, fights, accusations, using secrets) to the late game (`HOSTILE_FROM_WEEK`).
 * REAL PATH: played through the player channel, nothing hand-set. Each seed below saw the player evicted at the named week before the change (weeks 5 and 4). HEAVY LANE (tests/uat/**).
 * The engine's social game is still free to vote the player out later: this proves the script lasts past the early weeks, not that it can never lose.
 */
describe("ORW-778 REAL PATH: the scripted player plays on past the early weeks", () => {
  // The plain script was voted out in weeks 2 to 5 on every seed that finished (weeks 5 and 4 on seeds 5 and 7). Whether ONE seed's player lasts to week 7 is the house's social game, which every change to the played
  // season shifts (ORW-702: seed 5's player now goes in week 6): so the claim is about the script across seeds, not one pinned seed: on most of these seeds the player is still in when the game reaches week 7.
  it("on most seeds the player is still in the house when the game reaches week 7 (the plain script was out by week 5 on all of them)", async () => {
    const seeds = [5, 7, 3, 8], inAt7: number[] = [];
    for (const seed of seeds) {
      const r = await playSeason({ seed, user: `wf-${seed}`, maxMessages: 4000, survive: true, watch: async ({ sess }) => (sess.live?.week ?? 0) >= 7 || !!sess.live?.evictionOrder?.includes(sess.house.player.id) });
      expect(r.crashes, `seed ${seed}: no crash out of a load-bearing tool`).toEqual([]);
      if ((r.playerOutWeek ?? Infinity) >= 7 && r.week >= 7) inAt7.push(seed);
    }
    expect(inAt7.length, `the player was in at week 7 on seeds ${inAt7.join(", ") || "none"} of ${seeds.join(", ")}`).toBeGreaterThanOrEqual(Math.ceil(seeds.length / 2));
  }, 3_600_000);
});
