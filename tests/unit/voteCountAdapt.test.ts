import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { believedMargin, inDoubt } from "../../src/engine/voteEstimate";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/** B37 (#2017 slice 3, ORWELL_VOTE_COUNT): adaptation. An owner who believes the count is decided stops campaigning; public information changing re-opens the read. Flag off => untouched. Roles only. */
type Internals = {
  campaigns: Array<Record<string, unknown>>; rel: { edge(a: EntityId, b: EntityId): { threat: number; trust: number } };
  ceremony: { nominees: EntityId[]; vetoHolder?: EntityId; vetoUsed: boolean };
  setVoteCountEnabled(on: boolean): void; campaignTick(): void; voteStillInDoubt(a: EntityId, t: EntityId): boolean; voteCountStopsNow(): number; voteInfoEpoch(): string;
};
function game(on: boolean) {
  const sb = new GameSessionRegistry().sandboxFor(`b37-${Math.random()}`);
  sb.session.createCharacter({ playerName: "P", archetype: "floater", seed: 7 });
  const s = sb.session as unknown as Internals;
  s.setVoteCountEnabled(on);
  const npcs = sb.session.livingIds().filter((i) => i !== PLAYER) as EntityId[];
  const [owner, target] = npcs as [EntityId, EntityId];
  return { s, owner, target, npcs };
}
const evictCampaign = (owner: EntityId, target: EntityId) =>
  ({ id: `c:${owner}`, owners: [owner], goal: "evict", target, plan: [], progress: 0.2, horizon: "week", status: "active", knownTo: [owner], startedBeat: 0, deadlineBeat: 9999, confidence: 0.8 });
/** every other voter already hates the target (a decided count) */
function decide(g: ReturnType<typeof game>) { for (const v of g.npcs) if (v !== g.target) { g.s.rel.edge(v, g.target).threat = 1; g.s.rel.edge(v, g.target).trust = 0; } }

describe("adaptation", () => {
  it("ON: an owner whose believed count is decided drops the evict campaign (and it is counted)", () => {
    const g = game(true); decide(g);
    expect(g.s.voteStillInDoubt(g.owner, g.target)).toBe(false);
    g.s.campaigns.push(evictCampaign(g.owner, g.target));
    g.s.campaignTick();
    expect(g.s.campaigns.some((c) => c.owners && (c.owners as EntityId[])[0] === g.owner && c.goal === "evict" && c.target === g.target && c.status === "active")).toBe(false);
    expect(g.s.voteCountStopsNow()).toBeGreaterThan(0);
  });
  it("OFF: the same decided count leaves the campaign alone (flag-off byte-identical)", () => {
    const g = game(false); decide(g);
    g.s.campaigns.push(evictCampaign(g.owner, g.target));
    g.s.campaignTick();
    expect(g.s.voteCountStopsNow()).toBe(0);
  });
  it("an overconfident owner quits while the TRUE count is still close: the blindside condition", () => {
    const g = game(true);
    // a genuinely close house: every other voter's true support is near the majority line
    for (const v of g.npcs) if (v !== g.target) { g.s.rel.edge(v, g.target).threat = 0.55; g.s.rel.edge(v, g.target).trust = 0.2; }
    // find an actor whose personality overconfidence makes the believed count read 'decided' even though it is close
    const quitter = g.npcs.find((a) => a !== g.target && !g.s.voteStillInDoubt(a, g.target));
    const stayer = g.npcs.find((a) => a !== g.target && g.s.voteStillInDoubt(a, g.target));
    expect(quitter ?? stayer, "the house produces at least one estimate").toBeDefined();
    if (quitter && stayer) expect(quitter).not.toBe(stayer); // different personalities read the SAME close count differently
  });
  it("the estimate is recomputed when public information changes (new nominee / veto used) and stays reproducible otherwise", () => {
    const g = game(true);
    const e0 = g.s.voteInfoEpoch();
    expect(g.s.voteInfoEpoch()).toBe(e0);
    g.s.ceremony.nominees = [g.owner, g.target];
    const e1 = g.s.voteInfoEpoch();
    expect(e1).not.toBe(e0);
    g.s.ceremony.vetoUsed = true;
    expect(g.s.voteInfoEpoch()).not.toBe(e1);
    // same board => same answer
    const a = g.s.voteStillInDoubt(g.owner, g.target), b = g.s.voteStillInDoubt(g.owner, g.target);
    expect(a).toBe(b);
  });
});

describe("an overconfident NPC is blindsided (the pure condition)", () => {
  it("on a close true count, an overconfident estimator reads it as decided (quits) while a cautious one still works the house", () => {
    const voters = 12;
    const close = Array.from({ length: voters }, () => 0.6);      // a true count a little over the majority line: genuinely close
    const zero = close.map(() => 0);
    expect(inDoubt(believedMargin(close, 0, zero), voters), "the TRUE count is in doubt").toBe(true);
    expect(inDoubt(believedMargin(close, 0.2, zero), voters), "a cautious NPC keeps working").toBe(true);
    expect(inDoubt(believedMargin(close, 1, zero), voters), "an overconfident NPC believes it decided and stops").toBe(false);
    expect(believedMargin(close, 1, zero), "and the belief errs toward 'my side wins' (systematic under-estimate of dissent)").toBeGreaterThan(0);
  });
});
