import { describe, it, expect } from "vitest";
import { validateDossierCoherence } from "../../src/engine/castingIntake";

/**
 * ORW-356 — every game start logged a RED-eligible `cast-coherence` fault. The cast-genesis BACKGROUND of a
 * young man read "grew up the only grandkid of a piano teacher, half-raised on crossword puzzles ...": the
 * houseguest is the GRANDCHILD. `grandparentSelfReference` treated every "grandkid" as the houseguest being a
 * grandparent, so the engine floored the field at game start (fields: biography) and raised the fault. A
 * singular "the only grandkid of ..." names the grandchild; "has grandkids" / "a grandkid" still fail.
 * Roles only.
 */
const dossier = (background: string, age: number) =>
  validateDossierCoherence({ genderPresentation: "man", age, vocation: "data analyst", background });

describe("ORW-356 — the houseguest as someone's grandchild is coherent", () => {
  it.each([
    ["grew up the only grandkid of a piano teacher, half-raised on crossword puzzles", 22],
    ["the youngest grandkid of a large farming family, still calls every Sunday", 24],
    ["he is the favorite grandkid of a retired judge", 29],
  ] as const)("passes: %s (age %i)", (text, age) => {
    const res = dossier(text, age);
    expect(res.ok, JSON.stringify(res.contradictions)).toBe(true);
    expect(res.repairFields).not.toContain("biography");
  });
});

describe("ORW-356 — a houseguest who IS the grandparent still fails (negative controls)", () => {
  it.each([
    "dotes on his grandkids and works as a data analyst",
    "spoils his only grandkid every weekend",
    "has a grandkid on the way and works as a data analyst",
    "a grandfather of three who runs the church bake sale",
  ])("fails: %s", (text) => {
    const res = dossier(text, 25);
    expect(res.ok).toBe(false);
    expect(res.repairFields).toContain("background"); // ORW-430: judged per field; this text is the background
  });
});
