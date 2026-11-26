import { describe, it, expect } from "vitest";
import { bitterByPersonality } from "../../src/engine/jury";
import { JURY_GRUDGE, JURY_GRUDGE_PERSONALITY } from "../../src/engine/juryConstants";

/**
 * ORW-943: a juror's grudge weighs by who the juror is. Pure. The sizing rules: no grudge stays no grudge; no juror profile leaves the grudge as it was; a grudge-holder feels the same wrong
 * more than a forgiver; the product is held under the ceiling (below the manner term); and the juror is the only input, so the same rule holds for a player finalist and an NPC finalist.
 */
describe("ORW-943 bitterByPersonality", () => {
  const raw = -JURY_GRUDGE.max / 2;
  it("no grudge stays none; no archetype leaves the grudge unchanged", () => {
    expect(bitterByPersonality(0, "grudge-holder")).toBe(0);
    expect(bitterByPersonality(raw, undefined)).toBe(raw);
  });
  it("orders the archetypes: a grudge-holder weighs a wrong the most, a forgiver the least, a competitor as before", () => {
    const at = (a: Parameters<typeof bitterByPersonality>[1]): number => bitterByPersonality(raw, a);
    expect(at("grudge-holder")).toBeLessThan(at("loyalist"));
    expect(at("loyalist")).toBeLessThan(at("competitor"));
    expect(at("competitor")).toBe(raw);
    expect(at("competitor")).toBeLessThan(at("pragmatist"));
    expect(at("pragmatist")).toBeLessThan(at("forgiver"));
    expect(at("forgiver")).toBeLessThan(0);
  });
  it("is held to the ceiling, which stays under the manner term", () => {
    expect(bitterByPersonality(-JURY_GRUDGE.max, "grudge-holder")).toBe(-JURY_GRUDGE_PERSONALITY.ceiling);
    expect(JURY_GRUDGE_PERSONALITY.ceiling).toBeLessThan(0.48);
  });
});
