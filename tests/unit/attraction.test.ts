import { describe, it, expect } from "vitest";
import { ATTRACTION, BREAKUP, canBeDrawnTo, chemistryOf, attractionNow, seekPull, readsAsCouple, coupleNomPush, heartWins, playerShowmance } from "../../src/engine/attraction";
import { RELATIONSHIP_CONSTANTS } from "../../src/engine/relationshipConstants";

/** Theme A foundation (ORW-657..661): the core attraction model. Roles only. */
describe("Theme A foundation: attraction is one-sided, private, within orientation", () => {
  it("drawn only within the drawn one's own orientation; never to someone whose gender is unknown (the player who has not said)", () => {
    expect(canBeDrawnTo("straight", "woman", "man")).toBe(true);
    expect(canBeDrawnTo("straight", "woman", "woman")).toBe(false);
    expect(canBeDrawnTo("gay", "man", "man")).toBe(true);
    expect(canBeDrawnTo("lesbian", "woman", "man")).toBe(false);
    expect(canBeDrawnTo("pansexual", "man", "nonbinary")).toBe(true);
    expect(canBeDrawnTo("bisexual", "woman", undefined)).toBe(false);
  });
  it("most pairs have no chemistry; some do; it grows with time together and never past its ceiling", () => {
    const rolls = Array.from({ length: 1000 }, (_, i) => (i + 0.5) / 1000);
    const share = rolls.filter((r) => chemistryOf(r, true) > 0).length / rolls.length;
    expect(share).toBeCloseTo(ATTRACTION.chemistryShare, 2);
    expect(chemistryOf(0.01, false)).toBe(0);
    const c = chemistryOf(0.05, true);
    expect(attractionNow(c, 0)).toBe(0);
    expect(attractionNow(c, 2)).toBeGreaterThan(attractionNow(c, 1));
    expect(attractionNow(c, 999)).toBe(c);
    expect(seekPull(1)).toBe(ATTRACTION.seekWeight);
  });
});

describe("Theme A foundation: the couple, heart against game, the player", () => {
  it("a pair reads as a couple only from what the reader saw or was told, and an HOH outside it pushes one of them up", () => {
    expect(readsAsCouple(0.9, false)).toBe(false);
    expect(readsAsCouple(0.9, true)).toBe(true);
    expect(coupleNomPush(true, false)).toBeGreaterThan(0);
    expect(coupleNomPush(true, true)).toBe(0);
  });
  it("the stronger tie wins; a breakup is worse than a broken deal; the player is in a showmance only by their own acts", () => {
    expect(heartWins(0.7, 0.5, false)).toBe(true);
    expect(heartWins(0.5, 0.7, true)).toBe(false);
    expect(heartWins(0.6, 0.6, true)).toBe(true);
    const shock = RELATIONSHIP_CONSTANTS.BETRAYAL_SHOCK;
    expect(BREAKUP.trust).toBeLessThan(shock.trust!);
    expect(BREAKUP.affinity).toBeLessThan(shock.affinity!);
    expect(playerShowmance(0, true)).toBe(false);
    expect(playerShowmance(2, false)).toBe(false);
    expect(playerShowmance(2, true)).toBe(true);
  });
});
