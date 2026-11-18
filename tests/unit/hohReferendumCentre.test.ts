import { describe, it, expect } from "vitest";
import { voteChoice, type SeasonCtx } from "../../src/engine/liveSeason";
import { DECISION } from "../../src/engine/decisionConstants";
import type { DecisionWhy } from "../../src/engine/decisionWhy";

/**
 * ORW-634 (Fable stacking S-1; Ryne's option b): the HOH referendum reads a voter's alignment against the house's OWN typical bond, so a liked HOH has most of the house
 * with them and a disliked one most of it against them; and a "house power after the veto" pull keeps defying the HOH common. Played games only (the centre hook).
 * Roles only: an HOH, two nominees (the HOH's target and the pawn), a voter.
 */
const HOH = "npc:hoh", T = "npc:target", P = "npc:pawn", V = "npc:voter";
function ctxWith(bondToHoh: number, centre: number | undefined): SeasonCtx {
  const edge = (a: string, b: string) => ({ trust: 0.3, affinity: 0.3, threat: a === HOH && b === T ? 0.9 : a === HOH && b === P ? 0.1 : a === V && b === HOH ? 0 : 0.3 });
  const rel = { edge, bondStrength: (a: string, b: string) => (a === V && b === HOH ? bondToHoh : 0.3) };
  return { player: "player", statsOf: () => ({ physical: 0.5, mental: 0.5, social: 0.5 }), rel, ...(centre !== undefined ? { hohReferendumCentre: () => centre } : {}) } as unknown as SeasonCtx;
}
const referendumOn = (ctx: SeasonCtx) => {
  const rows: Array<Omit<DecisionWhy, "by" | "week">> = [];
  voteChoice(V, [T, P], ctx, [], HOH, (w) => rows.push(w));
  const opt = rows[0]!.options.find((o) => o.option === T)!;
  return { term: opt.terms.find(([n]) => n === "hoh-referendum")?.[1] ?? 0, inputs: rows[0]!.options[0]!.inputs ?? {} };
};

describe("ORW-634: the HOH referendum is centred on the house", () => {
  it("a voter warmer to the HOH than the house's norm gives them their target; a colder one keeps it; at the norm the house's power after the veto keeps it", () => {
    const centre = 0.3;
    expect(referendumOn(ctxWith(0.6, centre)).term).toBeGreaterThan(0); // aligned: evict the target
    expect(referendumOn(ctxWith(0.1, centre)).term).toBeLessThan(0); // opposed: keep the target, the pawn goes
    expect(referendumOn(ctxWith(centre, centre)).term).toBeCloseTo(-DECISION.vote.housePowerAfterVeto); // exactly at the norm: the house's own power
  });

  it("the same voter is aligned with a popular house's warm HOH only if warmer than the house's norm (popularity is relative to the house, not a fixed baseline)", () => {
    expect(referendumOn(ctxWith(0.5, 0.2)).term).toBeGreaterThan(0);
    expect(referendumOn(ctxWith(0.5, 0.7)).term).toBeLessThan(0);
  });

  it("the why record carries the voter's bond and the house's for the report", () => {
    const { inputs } = referendumOn(ctxWith(0.6, 0.3));
    expect(inputs.hohBond).toBeCloseTo(0.6);
    expect(inputs.houseBond).toBeCloseTo(0.3);
  });

  it("no hook (a headless sim): the old baseline read, no house-power term, no new inputs", () => {
    const { term, inputs } = referendumOn(ctxWith(0.6, undefined));
    expect(inputs.hohBond).toBeUndefined();
    expect(term).toBeGreaterThan(0); // the old read: well above the baseline bond
  });
});
