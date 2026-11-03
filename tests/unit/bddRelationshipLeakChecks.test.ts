import { describe, it, expect } from "vitest";
import {
  assertNoRelationshipValueProse,
  assertNoOpinionChangedProse,
  assertNoNumericRelationshipFields,
  numericRelationshipLeaks,
} from "../../features/support/relationshipLeakChecks";

/**
 * Positive control for feature 0023's "the opinion change is invisible" BDD sweep (PAT-2, #1989): the SAME check
 * functions the steps call must THROW on a real leak and stay quiet on the legitimate plain words.
 */
describe("BDD relationship-leak checks (positive control)", () => {
  it.each([
    "trust: 0.8", "trust level 7", "trust 7", "trust level 7/10", "threat (8)", "affinity of 0.4", "trust +0.2", '{"trust":0.8}',
  ])("prose value check throws on %j", (t) => {
    expect(() => assertNoRelationshipValueProse(`She nods. ${t}. Then leaves.`)).toThrow(/relationship value/);
  });

  it.each(["can I trust you?", "makes a threat sound like small talk", "she is no threat to anyone", "trust is earned"])(
    "prose value check passes on %j", (t) => {
      expect(() => assertNoRelationshipValueProse(t)).not.toThrow();
    },
  );

  it.each([
    "her opinion of you has soured", "his opinion of you softened", "her feelings toward you have cooled", "she has warmed to you and her opinion has warmed",
    "her opinion of you has grown", "her opinion turned", "her opinion got worse", "her opinion is better now", "she thinks less of you",
    "she thinks a little more of you", "he no longer trusts you", "she likes you more", "he trusts you less", "she feels differently about you",
  ])("opinion-changed check throws on %j", (t) => {
    expect(() => assertNoOpinionChangedProse(t)).toThrow(/opinion changed/);
  });

  it.each([
    "can I trust you?", "makes a threat sound like small talk", "spectators form opinions as it unfolds. The reactions are better when power has changed hands",
    "I'd like to see more of you around the kitchen", "She smiles. He likes you.",
  ])("opinion-changed check passes on %j", (t) => {
    expect(() => assertNoOpinionChangedProse(t)).not.toThrow();
  });

  it("structured walk throws on a numeric relationship value, at any depth", () => {
    expect(() => assertNoNumericRelationshipFields({ p: { npc: { trust: 0.8 } } })).toThrow(/structured player projection/);
    expect(() => assertNoNumericRelationshipFields({ p: [{ opinions: { a: [1, 2] } }] })).toThrow();
    expect(() => assertNoNumericRelationshipFields({ p: { relEdge: { x: 3 } } })).toThrow();
    expect(() => assertNoNumericRelationshipFields({ p: { threat: "0.5" } })).toThrow();
    expect(numericRelationshipLeaks({ npc: { trust: 0.8 } }, ["p"])).toEqual(["p.npc.trust=0.8"]);
  });

  it("structured walk passes on ordinary numbers and non-numeric relationship fields", () => {
    expect(() => assertNoNumericRelationshipFields({ p: { week: 3, hp: 5, knowledge: [1], knowledgeCount: 2, mood: "wary", trust: "wary"} })).not.toThrow();
  });
});
