import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { sessionCoreSupersetViolation } from "../../src/engine/sessionSnapshot";
import type { BeliefClaim } from "../../src/engine/beliefStore";

/** ORW-686 items 5 and 6. Roles only: a believer (h), the one a rumor is about (b), the one betrayed (v), voters and an evictee. */
type Seam = {
  live: { playedGame?: boolean; week: number; claims?: { seq: number; items: unknown[] }; beliefs?: Record<string, BeliefClaim[]>; voteRecord?: Array<{ week: number; evictee: string; voteOf: Record<string, string> }>; votesTalked?: string[] };
  talkAboutTheVote(): Array<{ id: string; listener: string; speaker: string }>;
  noteTargetsMeClaims(h: string): void;
};

describe("restart does not re-roll the vote talk (item 6)", () => {
  function played(seed: number) {
    const sb = new GameSessionRegistry().sandboxFor(`orw686-${seed}`);
    sb.session.createCharacter({ playerName: "The Player", seed });
    const s = sb.session as unknown as Seam;
    s.live.playedGame = true;
    const npcs = sb.session.livingIds().filter((id) => id !== PLAYER);
    const [e, sv] = [npcs[0]!, npcs[1]!];
    const voters = npcs.slice(2, 9);
    s.live.voteRecord = [{ week: s.live.week, evictee: e, voteOf: Object.fromEntries(voters.map((v, i) => [v, i % 3 === 0 ? sv : e])) }];
    return { sb, s };
  }
  it("the same eviction's talk is not had again after a save and restore; an old save loads as empty", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { sb, s } = played(seed);
      const first = s.talkAboutTheVote();
      if (first.length === 0) continue;
      const before = sb.session.snapshot();
      expect((before.live as { votesTalked?: string[] }).votesTalked?.length).toBe(1);
      const sb2 = new GameSessionRegistry().sandboxFor(`orw686-restored-${seed}`);
      sb2.session.restore(JSON.parse(JSON.stringify(before)));
      expect((sb2.session as unknown as Seam).talkAboutTheVote()).toEqual([]);
      // the save check accepts growth, and refuses a save that forgot it
      const grown = JSON.parse(JSON.stringify(before));
      grown.live.votesTalked.push("later");
      expect(sessionCoreSupersetViolation(grown as never, before as never)).toBeNull();
      const forgot = JSON.parse(JSON.stringify(before));
      delete forgot.live.votesTalked;
      expect(sessionCoreSupersetViolation(forgot as never, before as never)).toBe("votesTalked");
      // an old save without the field loads as empty and talks once (back-compatible)
      const old = JSON.parse(JSON.stringify(before));
      delete old.live.votesTalked;
      const sb3 = new GameSessionRegistry().sandboxFor(`orw686-old-${seed}`);
      sb3.session.restore(old);
      expect((sb3.session as unknown as Seam).talkAboutTheVote().length).toBeGreaterThan(0);
      return;
    }
    throw new Error("no seed produced vote talk");
  });
});

