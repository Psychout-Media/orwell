import { describe, it, expect } from "vitest";
import { CAUGHT_LIE, overclaimedKeeps } from "../../src/engine/caughtLies";
import { VOTE_TALK, decideVoteTalk, keepCredit } from "../../src/engine/voteTalk";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { BeliefClaim } from "../../src/engine/beliefStore";

/** ORW-594 (Fable T2-13) + ORW-613: vote talk steers, vote lies can be caught by counting, and the player hears how people voted. Roles only: voters (v1..v5), the evictee (e), the survivor (s), a listener (h). */
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

describe("in the live adapter", () => {
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
  it("through the real vote talk: the player is told in some houses (a scene they were in), and a believed keep's credit is taken back when the lie is caught", () => {
    let toPlayer = 0, credited = 0, reversed = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const sb = new GameSessionRegistry().sandboxFor(`votetalk-live-${seed}`);
      sb.session.createCharacter({ playerName: "The Player", seed });
      const s = sb.session as unknown as Seam & { talkAboutTheVote(): Array<{ id: string; listener: string; speaker: string; object?: string }>; catchLie(p: { holder: string; liar: string; claimId: string; confidence: number }): void; events?: unknown };
      s.live.playedGame = true;
      const npcs = sb.session.livingIds().filter((id) => id !== PLAYER);
      const [e, sv] = [npcs[0]!, npcs[1]!];
      const voters = npcs.slice(2, 9);
      for (const v of voters) for (const n of [e, sv]) s.rel.edge(n, v).affinity = 0.3;
      for (const h of npcs) { s.rel.edge(h, e).affinity = 0.9; } // the house liked the evictee: telling them "I kept them" earns credit
      s.rel.edge(PLAYER, e).affinity = 0.9;
      s.live.voteRecord = [{ week: s.live.week, evictee: e, voteOf: Object.fromEntries(voters.map((v, i) => [v, i % 3 === 0 ? sv : e])) }];
      const told = s.talkAboutTheVote();
      toPlayer += told.filter((c) => c.listener === PLAYER).length;
      for (const c of told.filter((x) => x.listener !== PLAYER)) {
        const b = (s.live.beliefs?.[c.listener] ?? []).find((x) => x.id.endsWith(`|${c.id}`));
        if (!b?.impact?.trust) continue;
        credited++;
        const withCredit = s.rel.edge(c.listener, c.speaker).trust;
        s.catchLie({ holder: c.listener, liar: c.speaker, claimId: c.id, confidence: 0.6 });
        if (s.rel.edge(c.listener, c.speaker).trust < withCredit) reversed++;
      }
    }
    expect(toPlayer).toBeGreaterThan(0);
    expect(credited).toBeGreaterThan(0);
    expect(reversed).toBe(credited);
  });
});
