import { describe, it, expect } from "vitest";
import { blocVotePick, blocVoteTerm, BLOC, type Bloc } from "../../src/engine/blocs";
import { voteChoice, type SeasonCtx } from "../../src/engine/liveSeason";
import { RelationshipModel } from "../../src/engine/relationships";
import { PLAYER, npc } from "../../src/domain/ids";
import { playedGame } from "../support/playedGame";

/**
 * ORW-972 (0043 "bloc-mates vote together"): on an eviction vote the bloc pulls a member toward the bloc's OWN pick (the majority of its members' reads, each without the bloc),
 * not toward the threat-derived shared target (which flipped the marginal member against the rest of the bloc). The player counts in that pick only as the voter knows the vote
 * the player told them they would cast. Roles only.
 */
const VOTER = npc(1), MATE = npc(2), A = npc(4), B = npc(5);
const bloc = (members: string[], sharedTarget: string | null = B): Bloc => ({ members, sharedTarget, cohesion: 0.9, loyaltyStrength: 1 });

describe("the bloc's own pick", () => {
  it("the majority of the members who vote (nominees do not); a tie or nobody counted is no pick", () => {
    const blocs = [bloc([VOTER, MATE, npc(3)])];
    const reads: Record<string, string> = { [VOTER]: B, [MATE]: A, [npc(3)]: A };
    expect(blocVotePick(blocs, VOTER, [A, B], (m) => reads[m])).toBe(A);
    expect(blocVotePick(blocs, VOTER, [A, B], (m) => (m === npc(3) ? undefined : reads[m]))).toBeUndefined(); // 1-1
    expect(blocVotePick([bloc([VOTER, A])], VOTER, [A, B], () => B)).toBe(B); // the nominee mate is not counted
    expect(blocVotePick([], VOTER, [A, B], () => A)).toBeUndefined();
  });
  it("the term shields a mate and leans toward the bloc's pick, never toward the shared target as such", () => {
    const blocs = [bloc([VOTER, MATE], B)];
    const w = BLOC.termWeight;
    expect(blocVoteTerm(blocs, VOTER, MATE, A)).toBe(-w);
    expect(blocVoteTerm(blocs, VOTER, A, A)).toBe(w);
    expect(blocVoteTerm(blocs, VOTER, B, A)).toBe(0);
    expect(blocVoteTerm(blocs, VOTER, B, undefined)).toBe(0);
    expect(blocVoteTerm([], VOTER, A, A)).toBe(0);
  });
});

describe("a bloc member votes with the bloc (pure voteChoice)", () => {
  // The voter's own read leans slightly to evicting B; the mate's read is clearly A.
  const ctxWith = (stated?: string): SeasonCtx => {
    const rel = new RelationshipModel(0.5);
    rel.edge(VOTER, A).threat = 0.5; rel.edge(VOTER, B).threat = 0.55;
    rel.edge(MATE, A).threat = 0.9; rel.edge(MATE, B).threat = 0.1;
    return { player: PLAYER, rel, ...(stated ? { playerStatedVoteFor: () => stated } : {}) } as unknown as SeasonCtx;
  };
  it("alone the voter evicts B; a bloc whose other member votes A, with the player's stated vote for A, pulls the voter to A", () => {
    expect(voteChoice(VOTER, [A, B], ctxWith(), [])).toBe(B);
    expect(voteChoice(VOTER, [A, B], ctxWith(A), [bloc([VOTER, MATE, PLAYER])])).toBe(A);
  });
  it("player parity: the player's vote counts only when they told the voter; not stated = not counted (a 1-1 bloc: no pull)", () => {
    expect(voteChoice(VOTER, [A, B], ctxWith(), [bloc([VOTER, MATE, PLAYER])])).toBe(B);
    // the player counts the same as an NPC mate would: an NPC third member reading A gives the same pull
    const npcMate = ctxWith();
    npcMate.rel.edge(npc(3), A).threat = 0.9; npcMate.rel.edge(npc(3), B).threat = 0.1;
    expect(voteChoice(VOTER, [A, B], npcMate, [bloc([VOTER, MATE, npc(3)])])).toBe(A);
  });
});

describe("the player's stated vote, from what the houseguest was told (played game, the open-ledger door)", () => {
  it("a this-week statement of the player's own vote to a houseguest is read as the player's pick; to someone else, or none, is not", () => {
    const g = playedGame({ seed: 3, user: "bl972" });
    const s = g.s as unknown as Record<string, any>;
    const room = (): string[] => (s.whereabouts()?.present ?? []).map((x: { id: string }) => x.id);
    g.playUntil(() => s.live?.week >= 2 && !s.getGameState().pending && room().length >= 1 && s.livingIds().filter((x: string) => x !== PLAYER && !room().includes(x)).length >= 3, 3000, "a week-2 room with someone in it and others elsewhere");
    const present: string[] = s.whereabouts().present.map((x: { id: string }) => x.id);
    const to = present[0]!;
    const living: string[] = s.livingIds().filter((x: string) => x !== PLAYER && x !== to);
    const [n0, n1] = [living[0]!, living[1]!];
    // someone the statement never reached: not in the room (the open ledger tells everyone present)
    const other = living.find((x) => x !== n0 && x !== n1 && !present.includes(x))!;
    expect(other, "setup: someone outside the room").toBeDefined();
    expect(s.playerStatedVoteFor(to, [n0, n1]), "nothing said: not counted").toBeUndefined();
    const r = s.recordOpenLedger({ text: `The player says they are voting against ${s.nameOf(n0)}.`, speaker: "player", addressedTo: [to], kind: "statement", claim: { kind: "voted-against", subject: PLAYER, object: n0 } });
    expect(r.accepted, JSON.stringify(r)).toBe(true);
    expect(s.playerStatedVoteFor(to, [n0, n1]), "told: the player's stated pick").toBe(n0);
    expect(s.playerStatedVoteFor(other, [n0, n1]), "someone the player did not tell does not count it").toBeUndefined();
    expect(s.playerStatedVoteFor(to, [n1, other]), "a vote between other nominees is not that pick").toBeUndefined();
  }, 300_000);
});
