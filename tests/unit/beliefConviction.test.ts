import { describe, expect, it } from "vitest";
import { CONVICTION, convictionFor, credulityOf, dealTrust, pathwayEvidence, underTest } from "../../src/engine/beliefConviction";
import type { BeliefClaim } from "../../src/engine/beliefStore";

/** 0160 / ORW-330 - conviction (Ryne's Q2 ruling): pure rules. Roles only. */
const b = (over: Partial<BeliefClaim>): BeliefClaim => ({ id: "x", holder: "npc:h", kind: "targets-me", subject: "npc:s", value: true, origin: "told", confidence: 0.5, week: 1, ...over });

describe("0160 conviction", () => {
  it("credulity comes from the sheet: an open, bonding type believes more readily than a calculating, clashing one; a burned houseguest grows wary", () => {
    const open = credulityOf({ archetype: "peacemaker", disposition: "bond" }, "npc:1", 3);
    const wary = credulityOf({ archetype: "mastermind", disposition: "clash" }, "npc:1", 3);
    expect(open).toBeGreaterThan(wary);
    expect(credulityOf({ archetype: "floater", temperamentDrift: 1 }, "npc:2", 3)).toBeLessThan(credulityOf({ archetype: "floater", temperamentDrift: -1 }, "npc:2", 3));
    expect(credulityOf({ archetype: "floater" }, "npc:2", 3)).toBe(credulityOf({ archetype: "floater" }, "npc:2", 3)); // deterministic per person
  });

  it("the same tale is held more surely by the credulous: 0.5 leaves it at the source's word", () => {
    expect(convictionFor(0.6, 0.5)).toBeCloseTo(0.6);
    expect(convictionFor(0.6, 0.9)).toBeGreaterThan(convictionFor(0.6, 0.1));
    expect(convictionFor(0.9, 1)).toBe(1);
  });

  it("a doubted, testable belief is under test; a conviction, a refuted one or a let-go one is not", () => {
    expect(underTest(b({ confidence: 0.45 }))).toBe(true);
    expect(underTest(b({ confidence: CONVICTION.asFact }))).toBe(false);
    expect(underTest(b({ confidence: 0.45, refuted: true }))).toBe(false);
    expect(underTest(b({ confidence: 0.1 }))).toBe(false);
    expect(underTest(b({ kind: "holds-power", confidence: 0.45 }))).toBe(false);
  });

  it("ORW-585: the night's evidence is what the holder holds through pathways, never the hidden truth", () => {
    const doubt = b({ id: "d", kind: "voted-against-me", subject: "x", source: "s1", confidence: 0.45 });
    // nothing else held: an unconfirmed doubt fades
    expect(pathwayEvidence(doubt, [doubt], "h")).toBe(-CONVICTION.fade);
    // a second source told them the same: it grows
    const second = b({ id: "d2", kind: "voted-against-me", subject: "x", source: "s2", confidence: 0.4 });
    expect(pathwayEvidence(doubt, [doubt, second], "h")).toBe(CONVICTION.step);
    // the same source repeating it is not a second source
    const repeat = b({ id: "d3", kind: "voted-against-me", subject: "x", source: "s1", confidence: 0.4 });
    expect(pathwayEvidence(doubt, [doubt, repeat], "h")).toBe(-CONVICTION.fade);
    // told the opposite (that x voted to keep them): it falls
    const keep = b({ id: "k", kind: "heard-rumor", nature: "voted-to-keep", subject: "x", object: "h", source: "s3", confidence: 0.5 });
    expect(pathwayEvidence(doubt, [doubt, keep], "h")).toBe(-CONVICTION.step);
    // caught the original source lying to them: it falls
    const liar = b({ id: "l", kind: "lied-to-me", subject: "s1", source: "s1", confidence: 0.8 });
    expect(pathwayEvidence(doubt, [doubt, liar], "h")).toBe(-CONVICTION.step);
  });

  it("a deal weighs as far as its holder trusts the other party (Ryne Q3)", () => {
    expect(dealTrust(0.8)).toBe(1);
    expect(dealTrust(0.25)).toBeCloseTo(0.5);
    expect(dealTrust(0)).toBe(0);
  });
});
