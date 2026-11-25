import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import { playUntil, type Stop } from "../realpath/playedSeason";

/**
 * ORW-691 B1-3 (0211 / ORW-648): the story's "turned" shape (a houseguest whose view of the player went from warm to cold) is reachable in a PLAYED season (ORW-813: before, the
 * week was stepped and the season finished by hand). Seed 3, the scripted talking player; on top of the script, the player picks one houseguest (the first they share a room with
 * once the week is under way): in week 1 they seek them out and bond whenever they share a room, from week 2 on they argue with them whenever they do. The weekly sampler and
 * the folds are the engine's own; at the crown the season's story tells that houseguest's view as turned. HEAVY LANE (tests/uat/**, the `real-path` leg). Roles only.
 */
const roster = (s: Stop): string[] => { const occ = (s.sess.sendTimeOccupancy() ?? s.sess.presence) as Map<string, string>; const here = occ.get(PLAYER); return [...occ].filter(([id, r]) => r === here && id !== PLAYER).map(([id]) => id); };

describe("ORW-691 B1-3: a view that goes from warm to cold is told as turned (played)", () => {
  it("a houseguest the player bonds with in week 1 and argues with after reads 'turned' in the season's story", async () => {
    let target: string | undefined; let n = 0;
    const at = await playUntil(3, async (s) => {
      if (s.sess.live?.finished) return true;
      const g = s.sess.getGameState();
      if (g.phase === "premiere" || g.pending) return false;
      const here = roster(s);
      if (!target && here.length > 0) target = here[0];
      if (!target || !here.includes(target) || !s.sess.livingIds().includes(PLAYER) || s.sess.live.evictionOrder.includes(PLAYER)) return false;
      const week = s.sess.live.week as number;
      if (n++ % 3 !== 0) return false; // a scene every few messages, not every one
      if (week === 1) await s.call("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, target], content: "we talked for hours and got close", kind: "bonding", toward: [target] });
      else await s.call("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, target], content: "we had a sharp argument", kind: "conflict", toward: [target] });
      return false;
    }, { user: "wf-3", maxMessages: 6000 });
    expect(target).toBeDefined();
    const retro = (await at.call("seasonRetrospective", {})) as { yourStories?: { stories: Array<{ name: string; shape: string }> } };
    const story = retro.yourStories?.stories.find((x) => x.name === at.sess.nameOf(target!));
    expect(story, "the houseguest has a story").toBeDefined();
    expect(story!.shape).toBe("turned");
  }, 900_000);
});
