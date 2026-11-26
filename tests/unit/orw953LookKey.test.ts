import { describe, it, expect } from "vitest";
import { buildCastPortraitPrompts, portraitLookKey } from "../../src/engine/portraitPrompts";
import { STYLE_ANCHOR_VARIANTS } from "../../src/engine/imageConstants";

/**
 * ORW-953: the staleness fingerprint of a face is taken from the portrait's `lookKey`, the inputs that change how ONE person looks.
 * A repair to someone's voice or biography (or to another houseguest) must move no one's key; a real change to the look must.
 * Invented fixtures, roles only.
 */
describe("ORW-953 portrait look key", () => {
  const anchor = STYLE_ANCHOR_VARIANTS[0]!;
  const look = (n: number) => ({
    heightBuild: `build ${n}`, skinTone: `skin ${n}`, hair: `hair ${n}`, facialFeatures: `features ${n}`,
    distinguishingMark: "none notable", ageLook: "looks their age", style: `style ${n}`, wardrobe: [`top ${n}`, `trousers ${n}`],
  });
  const cast = (n: number) => Array.from({ length: n }, (_, i) => ({
    id: `npc:${i + 1}`, name: `Fixture ${i + 1}`, appearance: `appearance ${i}`, age: 22 + i, presentation: `presentation ${i}`,
    physicalCharacteristics: look(i), ethnicity: "Fixture heritage", genderPresentation: (i % 2 ? "woman" : "man") as "man" | "woman",
    demeanor: `demeanor ${i}`, vocation: `job ${i}`, hometown: `Town ${i}, ST`, voiceEnergy: `energy ${i}`, biography: `biography ${i}`,
    castingType: { label: `label ${i}`, read: `read ${i}` },
  }));
  const keys = (c: ReturnType<typeof cast>) => Object.fromEntries(buildCastPortraitPrompts(c, anchor).map((p) => [p.houseguestId, p.lookKey]));

  it("every cast prompt carries a look key", () => {
    const k = keys(cast(15));
    expect(Object.keys(k)).toHaveLength(15);
    for (const v of Object.values(k)) expect(typeof v === "string" && v.length > 0).toBe(true);
    expect(new Set(Object.values(k)).size).toBe(15);
  });

  it("repairing one houseguest's biography and voice moves nobody's key, their own included", () => {
    const before = keys(cast(15));
    const repaired = cast(15);
    repaired[11] = { ...repaired[11]!, biography: "a repaired biography", voiceEnergy: "a repaired energy dial" };
    repaired[0] = { ...repaired[0]!, voiceEnergy: "another energy dial", demeanor: "another demeanor" };
    expect(keys(repaired)).toEqual(before);
  });

  it("a change to the look, age, presentation, job or hometown moves that person's key only", () => {
    const before = keys(cast(15));
    for (const edit of [
      (h: ReturnType<typeof cast>[number]) => ({ ...h, physicalCharacteristics: { ...h.physicalCharacteristics, hair: "a new cut" } }),
      (h: ReturnType<typeof cast>[number]) => ({ ...h, physicalCharacteristics: { ...h.physicalCharacteristics, wardrobe: ["a new coat"] } }),
      (h: ReturnType<typeof cast>[number]) => ({ ...h, age: h.age + 1 }),
      (h: ReturnType<typeof cast>[number]) => ({ ...h, vocation: "a new job" }),
      (h: ReturnType<typeof cast>[number]) => ({ ...h, hometown: "Elsewhere, ST" }),
    ]) {
      const edited = cast(15);
      edited[4] = edit(edited[4]!);
      const after = keys(edited);
      for (const id of Object.keys(before)) {
        if (id === "npc:5") expect(after[id]).not.toBe(before[id]);
        else expect(after[id]).toBe(before[id]);
      }
    }
  });

  it("a person with no structured look is keyed by the prose appearance", () => {
    const f = { age: 30, presentation: "calm" };
    expect(portraitLookKey({ ...f, appearance: "tall" })).not.toBe(portraitLookKey({ ...f, appearance: "short" }));
    expect(portraitLookKey({ ...f, appearance: "tall", biography: "x", voiceEnergy: "y" })).toBe(portraitLookKey({ ...f, appearance: "tall" }));
  });
});
