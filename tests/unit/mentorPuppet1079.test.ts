import { describe, it, expect } from "vitest";
import { STEER, isSeasoned, isMentorBond, isPuppetBond, markEviction, emptySteerState, steerLead } from "../../src/engine/mentorPuppet";
import { BOND, emptyBond, kindOf, foldScene, bondOf, bondStoreSuperset, type BondStore } from "../../src/engine/bondRecord";
import { voteChoice, VOTE_TERM_NAMES, type SeasonCtx } from "../../src/engine/liveSeason";
import { RelationshipModel } from "../../src/engine/relationships";
import { PLAYER, npc } from "../../src/domain/ids";

/** ORW-1079 (Ryne 2026-11-26, ORW-763; the coordinator's reading 2026-11-27: the kinds must change play): mentor and puppet-master bonds. Roles only. */
const warmRec = (strategy: number) => ({ ...emptyBond(), warmth: BOND.friendshipAt + 0.1, strategy });

describe("ORW-1079 mentor and puppet-master bonds (pure)", () => {
  it("seasoned = clearly older or cast as someone who knows the game", () => {
    expect(isSeasoned({ age: 24 }, { age: 24 + STEER.mentorAgeGap })).toBe(true);
    expect(isSeasoned({ age: 24 }, { age: 24 + STEER.mentorAgeGap - 1 })).toBe(false);
    expect(isSeasoned({ age: 40 }, { age: 22, castingType: "superfan" })).toBe(true);
    expect(isSeasoned({ age: 40 }, { age: 22, archetype: "mastermind" })).toBe(true);
    expect(isSeasoned({}, {})).toBe(false);
  });

  it("a mentor bond needs warmth AND enough strategy scenes AND a seasoned other", () => {
    expect(isMentorBond(warmRec(STEER.mentorStrategyScenes), true)).toBe(true);
    expect(isMentorBond(warmRec(STEER.mentorStrategyScenes - 1), true)).toBe(false);
    expect(isMentorBond(warmRec(STEER.mentorStrategyScenes), false)).toBe(false);
    expect(isMentorBond({ ...warmRec(9), warmth: 0 }, true)).toBe(false);
  });

  it("strategy scenes are counted in the record (only for the scene's principals) and only grow", () => {
    const store: BondStore = {};
    foldScene(store, "strategy", [npc(1), npc(2)]);
    foldScene(store, "strategy", [npc(1), npc(2)], { bystanders: [npc(3)] });
    expect(bondOf(store, npc(1), npc(2)).strategy).toBe(2);
    expect(bondOf(store, npc(3), npc(1)).strategy ?? 0).toBe(0);
    const before = JSON.parse(JSON.stringify(store)) as BondStore;
    store[`${npc(1)}|${npc(2)}`]!.strategy = 1;
    expect(bondStoreSuperset(store, before), "a strategy count that shrank is degradation").toBe(false);
  });

  it("puppet-master: voted with the other after working the game together in 2 of the last 3 evictions, while the other holds little warmth back; never the player as puppet", () => {
    let st = emptySteerState();
    let strat = 0;
    const vote = (week: number, same: boolean, worked: boolean) => {
      if (worked) strat++;
      st = markEviction(st, week, new Map([[npc(1), same ? npc(9) : npc(8)], [npc(2), npc(9)], [PLAYER, npc(9)]]), (h, o) => (h === npc(1) && o === npc(2) ? strat : 0));
    };
    vote(1, true, true);
    expect(isPuppetBond(st, npc(1), npc(2), emptyBond())).toBe(false);
    vote(1, false, false); // a second count in the same week is ignored
    vote(2, true, true);
    expect(isPuppetBond(st, npc(1), npc(2), emptyBond()), "2 of the last 3").toBe(true);
    expect(isPuppetBond(st, npc(1), npc(2), { ...emptyBond(), warmth: STEER.masterWarmthBelow }), "a warm 'master' is a friend, not a puppet-master").toBe(false);
    expect(isPuppetBond(st, PLAYER, npc(2), emptyBond()), "the player is never a puppet").toBe(false);
    vote(3, true, false); // same vote but no strategy scene since: not steered
    vote(4, false, true);
    expect(isPuppetBond(st, npc(1), npc(2), emptyBond()), "only 1 of the last 3 now").toBe(false);
    st = { ...st, exposed: [`${npc(1)}|${npc(2)}`] };
    vote(5, true, true); vote(6, true, true);
    expect(isPuppetBond(st, npc(1), npc(2), emptyBond()), "a steering seen through never comes back").toBe(false);
  });

  it("the kind reads puppet-master before mentor, after the record's own kinds", () => {
    expect(kindOf(warmRec(5), { mentor: true })).toBe("mentor");
    expect(kindOf(warmRec(5), { mentor: true, puppetMaster: true })).toBe("puppet-master");
    expect(kindOf({ ...warmRec(5), debt: BOND.protectorDebt }, { mentor: true })).toBe("protector");
    expect(kindOf(warmRec(5))).toBe("friendship");
  });

  it("the lead: a master first (the larger lean), else a mentor; the player never has one", () => {
    const reads = { puppet: (h: string, o: string) => h === npc(1) && o === npc(3), mentor: (h: string, o: string) => h === npc(1) && o === npc(2) };
    expect(steerLead(npc(1), [npc(2), npc(3)], reads)).toEqual({ by: npc(3), lean: STEER.puppetLean, kind: "puppet-master" });
    expect(steerLead(npc(1), [npc(2)], reads)).toEqual({ by: npc(2), lean: STEER.mentorLean, kind: "mentor" });
    expect(steerLead(PLAYER, [npc(2), npc(3)], { puppet: () => true, mentor: () => true })).toBeUndefined();
  });

  it("the vote leans to the leader's own pick; a nominee leader keeps themself; no lead is byte-identical", () => {
    expect(VOTE_TERM_NAMES.at(-1)).toBe("steer");
    const rel = new RelationshipModel(0.5);
    const fn: [string, string] = [npc(5), npc(6)];
    // the voter reads the two nominees as equal threats; the leader reads npc(6) as the bigger one
    rel.edge(npc(1), npc(5)).threat = 0.5; rel.edge(npc(1), npc(6)).threat = 0.5;
    rel.edge(npc(2), npc(5)).threat = 0.2; rel.edge(npc(2), npc(6)).threat = 0.9;
    const base = { rel } as unknown as SeasonCtx;
    const terms: Record<string, number> = {};
    const why = (w: { options: Array<{ option: string; terms: Array<[string, number]> }> }) => { for (const o of w.options) for (const [k, v] of o.terms) if (k === "steer") terms[o.option] = v; };
    expect(voteChoice(npc(1), fn, { ...base, steerLeadOf: () => ({ by: npc(2), lean: STEER.puppetLean }) }, [], undefined, why as never)).toBe(npc(6));
    expect(terms[npc(6)]).toBe(STEER.puppetLean);
    rel.edge(npc(1), npc(6)).threat = 0.49; // left alone the voter now leans to npc(5) ...
    expect(voteChoice(npc(1), fn, base)).toBe(npc(5));
    expect(voteChoice(npc(1), fn, { ...base, steerLeadOf: () => ({ by: npc(2), lean: STEER.puppetLean }) }), "... and the master's pick wins it").toBe(npc(6));
    expect(voteChoice(npc(1), fn, { ...base, steerLeadOf: () => ({ by: npc(6), lean: STEER.puppetLean }) }), "a nominee leader: the vote keeps them").toBe(npc(5));
  });
});

import { playedGame } from "../support/playedGame";

describe("ORW-1079 in a played season (the real decision path)", () => {
  type Why = { kind: string; options: Array<{ option: string; role: string; terms?: Array<[string, number]> }> };
  const steerDecided = (log: Why[]): number => log.filter((w) => w.kind === "vote").filter((w) => {
    const term = (role: string) => w.options.find((o) => o.role === role)?.terms?.find(([k]) => k === "steer")?.[1] ?? 0;
    return term("chosen") > 0;
  }).length;

  it("steering is recorded from real ballots and leads real votes; with the flag off nothing is recorded and no vote carries the term", () => {
    const on = playedGame({ seed: 3, user: "mp1079-on" });
    on.playToCrown();
    const liveOn = (on.s as unknown as { live: { steering?: { marks: Record<string, boolean[]> }; decisionWhy?: Why[] } }).live;
    expect(Object.keys(liveOn.steering?.marks ?? {}).length, "the steering record read the season's ballots").toBeGreaterThan(0);
    expect(steerDecided(liveOn.decisionWhy ?? []), "a mentor or puppet-master leaned at least one real vote").toBeGreaterThan(0);

    const off = playedGame({ seed: 3, user: "mp1079-off", before: (s) => s.setMentorPuppetEnabled(false) });
    off.playToCrown();
    const liveOff = (off.s as unknown as { live: { steering?: unknown; decisionWhy?: Why[] } }).live;
    expect(liveOff.steering).toBeUndefined();
    expect(steerDecided(liveOff.decisionWhy ?? [])).toBe(0);
  }, 900_000);
});
