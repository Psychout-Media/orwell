import { describe, it, expect } from "vitest";
import { nominationPlan } from "../../src/engine/season";
import { RelationshipModel } from "../../src/engine/relationships";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";

/**
 * B7 / #2017 M3 (approved tie-in #3) - open DEALS feed the HOH's nominations (today they reach only the eviction vote). An HOH who is promisor on an open protective deal with a candidate has
 * that candidate's nomination score lowered (a bounded push, like the campaign/memory pushes), so deal-keeping NPCs mostly keep their word; flag-off (ORWELL_DEAL_NOMS) byte-identical. Roles only.
 */
const ids = ["npc:1", "npc:2", "npc:3", "npc:4", "npc:5"];

describe("nominationPlan with a deal push", () => {
  it("absent the provider the plan is byte-identical", () => {
    const r = new RelationshipModel(0.5);
    expect(nominationPlan("npc:1", ids, r, { dealPush: undefined })).toEqual(nominationPlan("npc:1", ids, r, {}));
  });
  it("a strong negative push on the HOH's top target moves them off the block", () => {
    const r = new RelationshipModel(0.5);
    const base = nominationPlan("npc:1", ids, r, {});
    const kept = nominationPlan("npc:1", ids, r, { dealPush: (t) => (t === base.target ? -5 : 0) });
    expect(kept.nominees).not.toContain(base.target);
    expect(kept.nominees.length).toBe(2);
  });
});

describe("adapter provider (ORWELL_DEAL_NOMS)", () => {
  function started() {
    const sb = new GameSessionRegistry().sandboxFor(`dealnom-${Math.random()}`);
    sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
    sb.session.advanceGame(); sb.session.advanceGame();
    const [hoh, other] = [...sb.session.livingIds()].filter((i) => i !== PLAYER);
    return { sb, hoh: hoh!, other: other! };
  }
  type G = { setDealNomsEnabled(on: boolean): void; dealNomPushFor(target: string, holder: string): number; deals: { make(parties: [string, string], kind: string, terms: string): unknown } };
  it("0 with the flag off, and 0 when there is no open deal", () => {
    const { sb, hoh, other } = started(); const g = sb.session as unknown as G;
    expect(g.dealNomPushFor(other, hoh)).toBe(0);
    g.setDealNomsEnabled(true);
    expect(g.dealNomPushFor(other, hoh)).toBe(0);
  });
  it("an open protective deal the HOH made to the candidate lowers their score (negative, bounded); an unrelated houseguest is unaffected", () => {
    const { sb, hoh, other } = started(); const g = sb.session as unknown as G;
    g.setDealNomsEnabled(true);
    g.deals.make([hoh, other], "safety", "you're safe with me");
    const p = g.dealNomPushFor(other, hoh);
    expect(p).toBeLessThan(0);
    expect(p).toBeGreaterThanOrEqual(-0.5);
    const third = [...sb.session.livingIds()].find((i) => i !== PLAYER && i !== hoh && i !== other)!;
    expect(g.dealNomPushFor(third, hoh)).toBe(0);
  });
  it("the player is never a holder", () => {
    const { sb, other } = started(); const g = sb.session as unknown as G; g.setDealNomsEnabled(true);
    expect(g.dealNomPushFor(other, PLAYER)).toBe(0);
  });
});
