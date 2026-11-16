import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { tagCard, overCap, offendersFor, capFor, unrealClothes, isGarment, CAST_REALISM, type CardTags } from "../../src/domain/castRealism";

// ORW-480: the TypeScript tagger must tag exactly what the Python one does (frontend/src/orwell_cast_realism.py): one fixture, both sides.
const FIX = JSON.parse(readFileSync(new URL("../fixtures/orw480_tag_cases.json", import.meta.url), "utf8")) as {
  cases: { card: Parameters<typeof tagCard>[0]; tags: CardTags }[];
  unreal: [string, string[]][]; garments: [string, boolean][];
};

describe("ORW-480 casting-director table (TypeScript half)", () => {
  it("tags the shared fixture exactly as the Python tagger does", () => {
    expect(FIX.cases.length).toBeGreaterThan(100);
    for (const c of FIX.cases) expect(tagCard(c.card), JSON.stringify(c.card)).toEqual(c.tags);
  });
  it("unreal clothes and garment nouns agree with the fixture", () => {
    for (const [t, want] of FIX.unreal) expect(unrealClothes(t), t).toEqual(want);
    for (const [t, want] of FIX.garments) expect(isGarment(t), t).toBe(want);
  });
  it("caps: a share of the cast with a floor, a value's own cap wins", () => {
    expect(capFor("room", "kitchen", 15)).toBe(3);
    expect(capFor("sector", "care-and-public-service", 15)).toBe(2); // no sector on more than 2 of 15
    expect(capFor("sector", "trades-labor", 15)).toBe(3); // the wide sectors carry their own cap
  });
  it("a cast of identical cards is over the cap on every kind it repeats; later cards are the offenders", () => {
    const card = { vocation: "nurse", physicalCharacteristics: { onCamera: "She sits in the kitchen with a mug, smiling at the camera, the one who listens.", wardrobe: ["blue blazer", "jeans"] } };
    const tags = Array.from({ length: 6 }, () => tagCard(card));
    const over = overCap(tags);
    expect(over["prop"]?.["mug"]).toBe(6);
    expect(over["role"]?.["nurse"]).toBe(6);
    const off = offendersFor(tagCard(card), tags.slice(0, 2), 15);
    expect(off["prop"]).toEqual(["mug"]);
    expect(offendersFor(tagCard(card), tags.slice(0, 1), 15)["prop"]).toBeUndefined(); // the first two cards keep it
  });
  it("the table has the kinds the casting director needs", () => {
    for (const k of ["sector", "role", "prop", "expression", "smile-kind", "gaze", "pose", "room", "closing-read", "garment", "colour"]) expect(CAST_REALISM.kinds[k]).toBeDefined();
  });
});

describe("ORW-480 style fit (TypeScript half) agrees with the Python half on one fixture", () => {
  it("styleFitWeight matches the shared cases", async () => {
    const { styleFitWeight } = await import("../../src/domain/styleFit");
    const cases = JSON.parse(readFileSync(new URL("../fixtures/orw480_style_fit_cases.json", import.meta.url), "utf8")) as [string, string, string, number, number][];
    expect(cases.length).toBeGreaterThan(60);
    for (const [fam, vocation, hometown, age, want] of cases) expect(styleFitWeight(fam, { vocation, hometown, age }), `${fam} ${vocation}`).toBeCloseTo(want, 5);
  });
  it("a line cook from a small town is not dealt a model's minimalism by weight", async () => {
    const { styleFitWeight } = await import("../../src/domain/styleFit");
    expect(styleFitWeight("minimalist", { vocation: "line cook", hometown: "Sidney, Nebraska", age: 36 })).toBeLessThan(0.3);
    expect(styleFitWeight("skater", { vocation: "line cook", hometown: "Sidney, Nebraska", age: 24 })).toBeGreaterThan(1);
  });
});
