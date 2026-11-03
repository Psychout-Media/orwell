import { describe, it, expect } from "vitest";
import {
  assertNoRelationshipValueProse,
  assertNoOpinionChangedProse,
  assertNoNumericRelationshipFields,
  numericRelationshipLeaks,
  generatedPromptText,
} from "../../features/support/relationshipLeakChecks";

/**
 * Positive control for feature 0023's "the opinion change is invisible" BDD sweep (PAT-2, #1989): the SAME check
 * functions the steps call must THROW on a real leak and stay quiet on the legitimate plain words.
 */
describe("BDD relationship-leak checks (positive control)", () => {
  it.each([
    "trust: 0.8", "trust level 7", "trust 7", "trust level 7/10", "threat (8)", "affinity of 0.4", "trust +0.2", '{"trust":0.8}',
    "opinion: 7", '{"opinion":0.8}', "opinion level 7", "opinion of 0.4", "relationship: 3", '{"relationship":-0.2}', "relationship score 7/10", "relationship is 0.6",
  ])("prose value check throws on %j", (t) => {
    expect(() => assertNoRelationshipValueProse(`She nods. ${t}. Then leaves.`)).toThrow(/relationship value/);
  });

  it.each(["can I trust you?", "makes a threat sound like small talk", "she is no threat to anyone", "trust is earned", "in my opinion 3 of them left", "a relationship of 3 years", "opinion of the group"])(
    "prose value check passes on %j", (t) => {
      expect(() => assertNoRelationshipValueProse(t)).not.toThrow();
    },
  );

  it.each([
    "her opinion of you has soured", "his opinion of you softened", "her feelings toward you have cooled", "she has warmed to you and her opinion has warmed",
    "her opinion of you has grown", "her opinion turned", "her opinion got worse", "her opinion is better now", "she thinks less of you",
    "she thinks a little more of you", "he no longer trusts you", "she likes you more", "he trusts you less", "she feels differently about you",
    "her trust in you dropped", "her relationship with you changed", "the bond between you has soured", "your relationship with her changed",
    "her affinity for you has grown",
  ])("opinion-changed check throws on %j", (t) => {
    expect(() => assertNoOpinionChangedProse(t)).toThrow(/opinion changed/);
  });

  it.each([
    "can I trust you?", "makes a threat sound like small talk", "spectators form opinions as it unfolds. The reactions are better when power has changed hands",
    "I'd like to see more of you around the kitchen", "She smiles. He likes you.",
    // clause-bounded: a comma / semicolon ends the clause, so these unrelated words must not chain into a "change"
    "the opinion poll closed; the weather turned", "her opinion, honestly, is none of my business, and the mood turned",
    "your relationship is complicated, but the vote went better than expected",
  ])("opinion-changed check passes on %j", (t) => {
    expect(() => assertNoOpinionChangedProse(t)).not.toThrow();
  });

  it("structured walk throws on a numeric relationship value, at any depth", () => {
    expect(() => assertNoNumericRelationshipFields({ p: { npc: { trust: 0.8 } } })).toThrow(/structured player projection/);
    expect(() => assertNoNumericRelationshipFields({ p: [{ opinions: { a: [1, 2] } }] })).toThrow();
    expect(() => assertNoNumericRelationshipFields({ p: { relEdge: { x: 3 } } })).toThrow();
    expect(() => assertNoNumericRelationshipFields({ p: { threat: "0.5" } })).toThrow();
    for (const v of ["1e-3", ".5", "5.", "-2.5E+4", "+7"]) {
      expect(() => assertNoNumericRelationshipFields({ p: { trust: v } }), v).toThrow();
    }
    expect(numericRelationshipLeaks({ npc: { trust: 0.8 } }, ["p"])).toEqual(["p.npc.trust=0.8"]);
  });

  it("structured walk passes on ordinary numbers and non-numeric relationship fields", () => {
    expect(() => assertNoNumericRelationshipFields({ p: { week: 3, hp: 5, knowledge: [1], knowledgeCount: 2, mood: "wary", trust: "wary"} })).not.toThrow();
  });

  describe("generatedPromptText (the moment prompt's dynamic context is swept, only the fixed template is cut)", () => {
    const BASE = "BASE: spectators form opinions as it unfolds. Power has changed hands.";
    const FRAG = "FRAGMENT: the opinion mood is better when told plainly.";
    const sweep = (dynamic: string, hard = ""): string =>
      generatedPromptText({ systemPrompt: [BASE, FRAG, dynamic].join("\n\n"), hardConstraints: hard }, [BASE, FRAG]);

    it("passes on the bare fixed template (its plain words are not engine output)", () => {
      expect(() => assertNoOpinionChangedProse(sweep("Week 2. The house is quiet."))).not.toThrow();
      expect(() => assertNoRelationshipValueProse(sweep("Week 2. The house is quiet."))).not.toThrow();
    });
    it("throws on a relationship value inside the dynamic part of systemPrompt", () => {
      expect(() => assertNoRelationshipValueProse(sweep("Game context: Ana trust level 7/10 toward you."))).toThrow(/relationship value/);
    });
    it("throws on an opinion-change statement inside the dynamic part of systemPrompt", () => {
      expect(() => assertNoOpinionChangedProse(sweep("Story fact: her opinion of you has soured."))).toThrow(/opinion changed/);
    });
    it("still sweeps hardConstraints", () => {
      expect(() => assertNoRelationshipValueProse(sweep("ok", "Ana: threat (8)"))).toThrow(/relationship value/);
    });
    it("does not hide dynamic text when the fixed piece is absent from systemPrompt", () => {
      const out = generatedPromptText({ systemPrompt: "her opinion of you has soured" }, [BASE]);
      expect(() => assertNoOpinionChangedProse(out)).toThrow();
    });
  });
});
