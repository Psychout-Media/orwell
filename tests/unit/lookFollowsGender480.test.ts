import { describe, it, expect } from "vitest";
import { dealHairSpread, hairFits, recohereHair, HAIR_DESC } from "../../src/engine/deepProfile";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { hashSeed } from "../../src/engine/characterFactory";
import { dealFaceCards } from "../../src/engine/shotCards";

const MEN_CUTS = ["a sharp close-cropped fade", "a clean side-parted dark crop", "a polished slicked-back black style", "a classic dark-brown side part"];
const WOMEN_CUTS = ["a platinum-blond bob", "a smooth espresso-brown bob", "a voluminous dark blowout", "a rich auburn pixie cut"];

describe("ORW-480: the dealt look follows gender and heritage", () => {
  it("never deals a woman a men's cut or a man a women's cut over many seeded casts", () => {
    for (let s = 0; s < 60; s++) {
      const n = 15;
      const genders = Array.from({ length: n }, (_, i) => (i % 2 ? "woman" : "man"));
      const hair = dealHairSpread(new SeededRandom(hashSeed(`t:${s}`)), n, Array(n).fill(30), 1, genders);
      hair.forEach((h, i) => { expect(hairFits(h, genders[i])).toBe(true); });
    }
  });
  it("never deals a light blond, copper or auburn cut to a dark-haired heritage", () => {
    for (let s = 0; s < 60; s++) {
      const n = 15;
      const her = Array.from({ length: n }, (_, i) => (i % 3 === 0 ? "South Asian American" : i % 3 === 1 ? "Mexican American" : "Irish American"));
      const hair = dealHairSpread(new SeededRandom(hashSeed(`h:${s}`)), n, Array(n).fill(28), 1, undefined, her);
      hair.forEach((h, i) => { if (her[i] !== "Irish American") expect(/blond|copper|auburn|strawberry|platinum|golden|honey|sandy|caramel/i.test(h)).toBe(false); });
    }
  });
  it("with no gender or heritage known the deal is the old one", () => {
    const a = dealHairSpread(new SeededRandom(5), 15, Array(15).fill(30), 1);
    const b = dealHairSpread(new SeededRandom(5), 15, Array(15).fill(30), 1, Array(15).fill(undefined), Array(15).fill(undefined));
    expect(b).toEqual(a);
  });
  it("re-picks only the cuts that no longer fit after the gender changed, and keeps a coherent cast as it is", () => {
    const people = [
      { id: "a", hair: MEN_CUTS[0]!, age: 30, gender: "woman" },
      { id: "b", hair: WOMEN_CUTS[0]!, age: 30, gender: "woman" },
      { id: "c", hair: WOMEN_CUTS[1]!, age: 30, gender: "man" },
    ];
    const fix = recohereHair(new SeededRandom(1), people);
    expect(Object.keys(fix).sort()).toEqual(["a", "c"]);
    expect(hairFits(fix.a!, "woman") && hairFits(fix.c!, "man")).toBe(true);
    expect(recohereHair(new SeededRandom(1), people.map((p) => ({ ...p, hair: p.id === "a" ? WOMEN_CUTS[2]! : p.hair, gender: p.id === "c" ? "woman" : p.gender })))).toEqual({});
    expect(HAIR_DESC.length).toBeGreaterThan(20);
  });
  it("never deals a woman a thick neck, heavy brows or a wide heavy jaw, nor a man thin arched brows", () => {
    for (let s = 0; s < 40; s++) {
      const sheets = Array.from({ length: 15 }, (_, i) => ({
        id: `npc:${i + 1}`, name: `P${s}${i}`, age: 30, heightBuild: "solidly built, sturdy", presentation: "", genderPresentation: (i % 2 ? "woman" : "man") as "woman" | "man",
      }));
      const faces = dealFaceCards(sheets as never);
      sheets.forEach((sh) => {
        const f = faces.get(sh.id)!;
        const text = Object.values(f).join(" | ");
        if (sh.genderPresentation === "woman") expect(text).not.toMatch(/thick neck|heavy dark brows|wide, heavy jaw|strong neck and square|jaw muscle|heavy brow ridge|broad, squarish/);
        else expect(text).not.toMatch(/thin, high-arched brows/);
      });
    }
  });
});
