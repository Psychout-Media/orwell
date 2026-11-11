import { describe, it, expect } from "vitest";
import { validateDossierCoherence } from "../../src/engine/castingIntake";

/**
 * ORW-145 — the RC5 coherence belt (`enforceCastCoherence` at season start) repaired 4 of 15 model-authored
 * houseguests on the 2026-11-06 playtest and flagged each one RED-eligible. Its age-vs-biography rule (ii) is
 * meant to catch a houseguest's OWN implausible life ("a devoted grandmother who spent thirty years running a
 * diner", at 22), but it read every grandparent word and every year span in the biography as the
 * houseguest's. A young houseguest raised by a grandmother, or whose parents ran a business for thirty years,
 * lost the whole biography at game start. The repair clears the field, so the narrator falls back to the
 * structured facets.
 *
 * Both ways: a relative's grandparent or span passes; the houseguest's own still fails. Roles only.
 */

const bio = (biography: string, age: number, genderPresentation: "man" | "woman" = "woman") =>
  validateDossierCoherence({ genderPresentation, biography, age });

describe("ORW-145 — a relative's life is not the houseguest's", () => {
  it.each([
    ["Raised by her grandmother in Tulsa, she learned to cook before she could read. She now runs a food truck.", 27, "woman"],
    ["He grew up on his grandfather's farm outside Omaha and still drives the old truck. He teaches chemistry.", 24, "man"],
    ["She still calls her grandma every Sunday. She works nights as a nurse.", 25, "woman"],
    ["Her great-grandmother crossed the border with nothing. She is the first in the family to finish college.", 23, "woman"],
    ["His family has run the same 40-year-old diner in Reno since before he was born. He manages the night shift.", 30, "man"],
    ["His parents spent thirty years building a landscaping company. He joined it after high school.", 23, "man"],
    ["Her family has lived on the same street for decades. She left for college and came back.", 19, "woman"],
    ["She restores a 30-year-old pickup on weekends. By day she is a dental hygienist.", 26, "woman"],
  ] as const)("passes: %s (age %i)", (text, age, gender) => {
    const res = bio(text, age, gender);
    expect(res.ok, JSON.stringify(res.contradictions)).toBe(true);
    expect(res.repairFields).not.toContain("biography");
  });
});

describe("ORW-145 — the houseguest's own implausible life still fails", () => {
  it.each([
    ["A devoted grandmother who spent thirty years running a diner in her hometown.", 22, "the Donna object"],
    ["She dotes on her grandkids every Sunday and sells real estate.", 28, "grandchildren make her the grandparent"],
    ["He spent thirty years as a firefighter before retiring.", 25, "an own career span"],
    ["As a grandmother of three, she runs the church bake sale.", 30, "a self-description"],
    ["She is 40 years old and restless.", 25, "a stated age beyond the pinned age"],
    ["After her parents divorced, she spent thirty years in Ohio.", 26, "her own span after a relative clause"],
  ] as const)("fails: %s (age %i, %s)", (text, age, _why) => {
    const res = bio(text, age);
    expect(res.ok).toBe(false);
    expect(res.repairFields).toContain("biography");
  });
});
