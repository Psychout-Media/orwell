import { describe, it, expect } from "vitest";
import { CAUGHT_LIE, overclaimedKeeps } from "../../src/engine/caughtLies";
import { VOTE_TALK, decideVoteTalk, keepCredit } from "../../src/engine/voteTalk";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { BeliefClaim } from "../../src/engine/beliefStore";

/** ORW-594 (Fable T2-13) + ORW-613: vote talk steers, vote lies can be caught by counting, and the player hears how people voted. UNIT checks (ORW-810: the played-season checks are in tests/realpath/voteTalkSteers.test.ts). Roles only: voters (v1..v5), the evictee (e), the survivor (s), a listener (h). */
const keepClaim = (speaker: string, listener = "h") => ({ id: `c-${speaker}`, speaker, listener, kind: "voted-to-keep", subject: speaker, object: "e" });

describe("catch by counting (caughtLies.ts)", () => {
  const tally = { evictee: "e", evictVotes: 4, voters: ["v1", "v2", "v3", "v4", "v5"] }; // one keep vote exists
  it("claims that fit the count catch no one", () => {
    expect(overclaimedKeeps(tally, [keepClaim("v1")], () => 0.5)).toEqual([]);
  });
  it("more keep claims than keep votes: the listener suspects the excess, least trusted first", () => {
    const trust: Record<string, number> = { v1: 0.9, v2: 0.2, v3: 0.5 };
    expect(overclaimedKeeps(tally, [keepClaim("v1"), keepClaim("v2"), keepClaim("v3")], (s) => trust[s]!)).toEqual(["v2", "v3"]);
  });
  it("counts distinct voters only; a non-voter or a keep of someone else does not count", () => {
    const heard = [keepClaim("v1"), keepClaim("v1"), { ...keepClaim("x9") }, { ...keepClaim("v2"), object: "s" }];
    expect(overclaimedKeeps(tally, heard, () => 0.5)).toEqual([]);
    expect(CAUGHT_LIE.counting).toBeLessThan(CAUGHT_LIE.impossible);
  });
});

describe("vote talk reaches the player and earns credit (voteTalk.ts)", () => {
  it("the player is a candidate listener like anyone (ORW-613)", () => {
    const likes = (l: string, of: string) => (l === PLAYER && of === "sp" ? 0.95 : 0.3);
    const said = decideVoteTalk({ speaker: "sp", candidates: [PLAYER, "a", "b"], real: "e", nominees: ["e", "s"], cunning: 0.4, candor: 0.5, likes, rolls: { tell: 0, pick: 0, lie: 0.99 } });
    expect(said?.claim.listener).toBe(PLAYER);
  });
  it("a believed keep earns credit only with a listener who liked the kept one", () => {
    expect(keepCredit(0.4)).toBe(0);
    expect(keepCredit(1)).toBeCloseTo(VOTE_TALK.keepCredit, 12);
  });
});

describe("in the live adapter (unit: the vote record, bonds and tellings are set by hand)", () => {
  // ORW-810: the player being told, the keep credit and a unanimous count catching a credited keep are proven in a played season (tests/realpath/voteTalkSteers.test.ts). These two catches
  // were not reached in forty seasons played to the crown (seeds 1-40, sandboxes wf-<seed>, the scripted talking player; ORW-829, 2026-11-24), so they stay hand-set here.
  it.todo("real path: a listener told by more believed voters that they kept the evictee than the count has keep votes catches the excess (counting) - blocked: not reached in forty played seasons, seeds 1-40 (ORW-829)");
  it.todo("real path: a keep claim told after the count is public, and ruled out by it, is caught at once - blocked: not reached in forty played seasons, seeds 1-40 (ORW-829, 0154)");
  type Seam = {
    live: { playedGame?: boolean; week: number; claims?: { seq: number; items: Array<{ id: string; listener: string; speaker: string; kind: string }> }; beliefs?: Record<string, BeliefClaim[]>; voteRecord?: Array<{ week: number; evictee: string; voteOf: Record<string, string> }> };
    rel: { edge(a: string, b: string): { trust: number; affinity: number } };
    tellClaim(c: { kind: string; speaker: string; listener: string; subject: string; object?: string; isTrue: boolean; intent: string }): { id: string } | undefined;
    evictionCountPublic(t: { evictee: string; evictVotes: number; voters: string[] }): void;
  };
  function house(seed: number) {
    const sb = new GameSessionRegistry().sandboxFor(`votetalk-${seed}`);
    sb.session.createCharacter({ playerName: "The Player", seed });
    const s = sb.session as unknown as Seam;
    s.live.playedGame = true;
    const [h, v1, v2, v3, v4, sv, e] = sb.session.livingIds().filter((id) => id !== PLAYER);
    return { s, h: h!, voters: [h!, v1!, v2!, v3!, v4!], survivor: sv!, evictee: e! };
  }
  it("three voters tell one listener they kept the evictee when the count has one keep vote: two are caught (counting)", () => {
    const { s, h, voters, evictee } = house(31);
    const [, v1, v2, v3] = voters;
    for (const v of [v1, v2, v3]) s.rel.edge(h, v!).trust = v === v1 ? 0.9 : 0.3;
    for (const v of [v1, v2, v3]) s.tellClaim({ kind: "voted-to-keep", speaker: v!, listener: h, subject: v!, object: evictee, isTrue: false, intent: "mislead" });
    s.evictionCountPublic({ evictee, evictVotes: voters.length - 1, voters });
    const liars = (s.live.beliefs?.[h] ?? []).filter((b) => b.kind === "lied-to-me").map((b) => b.subject).sort();
    expect(liars).toEqual([v2!, v3!].sort());
    s.evictionCountPublic({ evictee, evictVotes: voters.length - 1, voters }); // never caught twice
    expect((s.live.beliefs?.[h] ?? []).filter((b) => b.kind === "lied-to-me")).toHaveLength(2);
  });
  it("a vote claim told after the count is public is checked against it at once", () => {
    const { s, h, voters, evictee } = house(32);
    s.live.voteRecord = [{ week: s.live.week, evictee, voteOf: Object.fromEntries(voters.filter((v) => v !== h).map((v) => [v, evictee])) }]; // unanimous
    const liar = voters[1]!;
    s.tellClaim({ kind: "voted-to-keep", speaker: liar, listener: h, subject: liar, object: evictee, isTrue: false, intent: "mislead" });
    expect((s.live.beliefs?.[h] ?? []).some((b) => b.kind === "lied-to-me" && b.subject === liar)).toBe(true);
  });
});
