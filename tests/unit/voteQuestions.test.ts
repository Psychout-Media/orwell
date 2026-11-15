import { describe, it, expect } from "vitest";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { Agenda } from "../../src/engine/agenda";
import { questionsAfterVote, questionLive, questionAnswered, QUESTION_ANSWERED_CONFIDENCE, type VoteQuestion } from "../../src/engine/voteQuestions";
import type { DeductionRead } from "../../src/engine/voteDeduction";

/**
 * ORW-342 (theme 1; find-out goals): after an eviction vote a nominee who survived, and a voter on the losing side, are left with a question ("who voted against me / who flipped")
 * whose suspect is their OWN deduced read, never the sealed ballot. Roles only (survivor, evictee, voter, suspect).
 */
const SURVIVOR = "npc:1", EVICTEE = "npc:2", V1 = "npc:3", V2 = "npc:4", V3 = "npc:5", V4 = "npc:6", HOH = "npc:7";
/** the survivor reads V3 as the threat and distrusts them; reads the true voters V1 and V2 as friends. */
const rel = (over: Record<string, { trust: number; threat: number }> = {}): DeductionRead => ({
  edge: (from, to) => over[`${from}>${to}`] ?? { trust: 0.5, threat: 0.3 },
});
const facts = (voteOf: Record<string, string>) => ({ week: 4, evictee: EVICTEE, nominees: [SURVIVOR, EVICTEE], voteOf, player: PLAYER });

describe("what a vote leaves behind (pure)", () => {
  // the sealed ballot: V1 and V2 voted against the survivor (to evict the survivor), V3 and V4 voted to evict the evictee... a split
  const BALLOT = { [V1]: SURVIVOR, [V2]: SURVIVOR, [V3]: EVICTEE, [V4]: EVICTEE };

  it("a survivor's suspect is their OWN read, never the sealed ballot (sentinel: the true voters are not named)", () => {
    const r = rel({ [`${SURVIVOR}>${V3}`]: { trust: 0.05, threat: 0.95 }, [`${SURVIVOR}>${V4}`]: { trust: 0.1, threat: 0.9 }, [`${SURVIVOR}>${V1}`]: { trust: 0.9, threat: 0.05 }, [`${SURVIVOR}>${V2}`]: { trust: 0.9, threat: 0.05 } });
    const q = questionsAfterVote(facts(BALLOT), r).find((x) => x.holder === SURVIVOR)!;
    expect(q.count, "the public tally: two votes were cast against them").toBe(2);
    expect([V3, V4]).toContain(q.suspect); // wrong on purpose: the survivor trusts the true voters and suspects the others
    expect([V1, V2]).not.toContain(q.suspect);
  });

  it("the evictee and the player are left no question; a nominee with no votes against them is left none", () => {
    const qs = questionsAfterVote(facts({ [V1]: EVICTEE, [V2]: EVICTEE, [V3]: EVICTEE }), rel());
    expect(qs.some((q) => q.holder === EVICTEE || q.holder === PLAYER)).toBe(false);
    expect(qs.some((q) => q.holder === SURVIVOR), "nobody voted against the survivor").toBe(false);
  });

  it("a voter on the losing side asks who flipped; a voter on the winning side does not", () => {
    const qs = questionsAfterVote(facts({ [V1]: SURVIVOR, [V2]: EVICTEE, [V3]: EVICTEE, [V4]: EVICTEE }), rel());
    expect(qs.some((q) => q.holder === V1)).toBe(true);
    expect([V2, V3, V4].some((v) => qs.some((q) => q.holder === v))).toBe(false);
  });

  it("a question is live through the week after the vote and lapses at its close", () => {
    const q = { holder: SURVIVOR, ref: "r", week: 4, pool: [], count: 1 } as VoteQuestion;
    expect([4, 5].map((w) => questionLive(q, w))).toEqual([true, true]);
    expect(questionLive(q, 6)).toBe(false);
  });

  it("it is answered once the holder's own read has become confident, not before", () => {
    const pool = [V1, V2, V3, V4, HOH];
    const q = { holder: SURVIVOR, ref: "r", week: 4, pool, count: 1 } as VoteQuestion;
    expect(questionAnswered(q, rel()), "every read the same: an ambiguous deduction").toBe(false);
    const sure = rel({ [`${SURVIVOR}>${V3}`]: { trust: 0, threat: 1 }, [`${SURVIVOR}>${V1}`]: { trust: 1, threat: 0 }, [`${SURVIVOR}>${V2}`]: { trust: 1, threat: 0 }, [`${SURVIVOR}>${V4}`]: { trust: 1, threat: 0 }, [`${SURVIVOR}>${HOH}`]: { trust: 1, threat: 0 } });
    expect(questionAnswered(q, sure)).toBe(true);
    expect(QUESTION_ANSWERED_CONFIDENCE).toBeGreaterThan(0.5);
  });
});

type S = {
  livingIds(): EntityId[];
  live: { week: number; agendas?: Record<string, Agenda>; voteQuestions?: VoteQuestion[] };
  agendaView(id: EntityId): { openQuestions: Array<{ ref: string; suspect?: string }>; answered: string[] } | undefined;
  agendaRecheck(trigger: string): void;
};
async function setup() {
  const reg = composeRuntime({ clock: new FakeClock(), seed: 11 }).registry;
  const user = `vote-q-${Math.random()}`;
  const mcp = reg.resolver()("player", user);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed: 11, archetype: "floater" });
  await mcp.callTool("noteMessage", { messageId: "first" });
  const s = reg.sandboxFor(user).session as unknown as S;
  const [holder, suspect] = s.livingIds().filter((i) => i !== PLAYER) as [EntityId, EntityId];
  return { s, holder, suspect };
}

describe("the agenda sees the question and a find-out goal forms (live)", () => {
  it("a houseguest left with a question forms a find-out goal naming their suspect; another's question is not theirs", async () => {
    const { s, holder, suspect } = await setup();
    s.live.voteQuestions = [{ holder, ref: `vote:${s.live.week}:${holder}`, week: s.live.week, suspect, pool: [], count: 1 }];
    expect(s.agendaView(holder)!.openQuestions).toEqual([{ ref: `vote:${s.live.week}:${holder}`, suspect }]);
    const other = s.livingIds().find((i) => i !== PLAYER && i !== holder)!;
    expect(s.agendaView(other)!.openQuestions).toEqual([]);
    s.agendaRecheck("eviction");
    const goal = s.live.agendas![holder]!.goals.find((g) => g.kind === "find-out");
    expect(goal, "a find-out goal formed").toBeDefined();
    expect(goal!.target).toBe(suspect);
  });

  it("an old question (two weeks on) is gone from the view", async () => {
    const { s, holder, suspect } = await setup();
    s.live.voteQuestions = [{ holder, ref: "old", week: s.live.week - 2, suspect, pool: [], count: 1 }];
    expect(s.agendaView(holder)!.openQuestions).toEqual([]);
  });
});
