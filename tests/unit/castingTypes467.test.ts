import { describe, it, expect } from "vitest";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { generateHouse, hashSeed } from "../../src/engine/characterFactory";
import { generateDiversityLayer } from "../../src/engine/diversity";
import { generateCastDeepLayer } from "../../src/engine/deepProfile";
import {
  CASTING_TYPES, dealCastingTypes, recohereCastingTypes, castingLabelFor, castingLabelsOf, type CastingPresentation,
} from "../../src/domain/castingTypes";
import { CASTING_TYPE_FIT, traitContradictions } from "../../src/domain/traitConsistency";

// ORW-467: the old names are back, the list is wide, each type leans (never rules) and wears a label for the person.

const PRESENTATIONS: CastingPresentation[] = ["man", "woman", "nonbinary"];
const castOf = (seed: number) => {
  const { npcs } = generateHouse(new SeededRandom(seed));
  const div = generateDiversityLayer(seed, npcs); // the same fold the game does before the deep layer
  for (const n of npcs) { n.character.genderPresentation = div.public[n.id]!.genderPresentation; n.character.age = div.public[n.id]!.age; }
  const layer = generateCastDeepLayer(seed, npcs);
  return npcs.map((n) => ({ n, t: layer.public[n.id]!.castingType, g: n.character.genderPresentation! }));
};
const SEEDS500 = Array.from({ length: 500 }, (_, i) => 11 + i * 37);

describe("ORW-467 the list", () => {
  it("has the old names back and 55 or more types, each with a read of five or more words", () => {
    expect(CASTING_TYPES.length).toBeGreaterThanOrEqual(55);
    expect(new Set(CASTING_TYPES.map((t) => t.id)).size).toBe(CASTING_TYPES.length);
    expect(CASTING_TYPES.find((t) => t.id === "diva")!.label).toBe("the diva");
    expect(CASTING_TYPES.find((t) => t.id === "silver-fox")!.label).toBe("the silver fox");
    expect(castingLabelFor(CASTING_TYPES.find((t) => t.id === "silver-fox")!, "woman")).toBe("the silver vixen");
    for (const t of CASTING_TYPES) expect(t.read.split(/\s+/).length, t.id).toBeGreaterThanOrEqual(5);
  });

  it("every lean weight is a positive integer (a lean is never a rule) and every label reads back to its id", () => {
    for (const t of CASTING_TYPES) {
      for (const g of PRESENTATIONS) { const w = t.lean?.[g] ?? 3; expect(Number.isInteger(w) && w >= 1, `${t.id} ${g}`).toBe(true); }
      for (const label of castingLabelsOf(t)) {
        // the card check reads the label back to this type: a contradicting trait set is flagged, so the label resolved
        const bad = { archetype: "no-such-archetype", castingType: { label } };
        expect(traitContradictions(bad), `${t.id}: ${label}`).toContain("trait-casting-type");
        expect(CASTING_TYPE_FIT[t.id], t.id).toBeDefined();
      }
    }
  });

  it("the nonbinary label carries no gendered word", () => {
    for (const t of CASTING_TYPES) {
      expect(castingLabelFor(t, "nonbinary"), t.id).not.toMatch(/\b(he|she|his|her|man|woman|guy|guys|girl|girls|boy|queen|king|lady|gentleman|vixen|mom|dad|aunt|uncle|hunk|bombshell|dame)\b/i);
      expect(t.read, t.id).not.toMatch(/\b(he|she|his|her|man|woman|guy|girl|boy|handsome|beautiful)\b/i);
    }
  });

  it("a woman's variant never reads male and a man's never reads female", () => {
    for (const t of CASTING_TYPES) {
      expect(castingLabelFor(t, "woman"), t.id).not.toMatch(/\b(man|guy|guys|boy|king|uncle|dad|hunk|fox)\b/i);
      expect(castingLabelFor(t, "man"), t.id).not.toMatch(/\b(woman|girl|girls|queen|aunt|mom|vixen|bombshell|dame)\b/i);
    }
  });

  it("age leans: the silver fox is never young, the baby of the house never old", () => {
    for (const seed of SEEDS500.slice(0, 200)) for (const { n, t } of castOf(seed)) {
      if (t.minAge !== undefined) expect(n.character.age, `${seed} ${t.id}`).toBeGreaterThanOrEqual(t.minAge);
      if (t.maxAge !== undefined) expect(n.character.age, `${seed} ${t.id}`).toBeLessThanOrEqual(t.maxAge);
    }
  });
});

describe("ORW-467 the deal", () => {
  it("over 500 seeded casts: the lean shows (diva about 8 in 10 women) and no pairing is out of reach", () => {
    const seen = new Map<string, Record<CastingPresentation, number>>();
    for (const seed of SEEDS500) {
      const c = castOf(seed);
      expect(new Set(c.map((x) => x.t.id)).size, `seed ${seed}`).toBe(c.length); // no type twice in a cast
      for (const { t, g } of c) {
        const r = seen.get(t.id) ?? { man: 0, woman: 0, nonbinary: 0 };
        r[g]++; seen.set(t.id, r);
        expect(t.label, `${seed} ${t.id}`).toBe(castingLabelFor(CASTING_TYPES.find((x) => x.id === t.id)!, g));
      }
    }
    const share = (id: string, g: CastingPresentation) => { const r = seen.get(id)!; return r[g] / (r.man + r.woman + r.nonbinary); };
    const total = (id: string) => { const r = seen.get(id)!; return r.man + r.woman + r.nonbinary; };
    expect(total("diva")).toBeGreaterThan(100);
    const womenOfDiva = share("diva", "woman") / (1 - share("diva", "nonbinary")); // women among the binary holders
    expect(womenOfDiva).toBeGreaterThanOrEqual(0.7);
    expect(womenOfDiva).toBeLessThanOrEqual(0.9);
    const menOfTrash = share("trash-talker", "man") / (1 - share("trash-talker", "nonbinary"));
    expect(menOfTrash).toBeGreaterThanOrEqual(0.7);
    // a man is dealt the diva sometimes, a woman the trash talker sometimes
    expect(seen.get("diva")!.man).toBeGreaterThan(0);
    expect(seen.get("trash-talker")!.woman).toBeGreaterThan(0);
    console.log("ORW-467 lean (women share of binary holders): diva", womenOfDiva.toFixed(3), "trash-talker men", menOfTrash.toFixed(3));
  });

  it("no pairing is impossible: every type is dealt to every presentation by some seed (age allowing)", () => {
    for (const t of CASTING_TYPES) for (const g of PRESENTATIONS) {
      const age = t.minAge ?? t.maxAge ?? 30;
      let hit = false;
      for (let seed = 1; seed <= 4000 && !hit; seed++) {
        hit = dealCastingTypes(new SeededRandom(seed), 1, [age], [{ genderPresentation: g }])[0]!.id === t.id;
      }
      expect(hit, `${t.id} ${g}`).toBe(true);
    }
  });

  it("is seeded, one draw per houseguest, and a function of the same inputs", () => {
    const traits = Array.from({ length: 15 }, (_, i) => ({ archetype: "floater", genderPresentation: PRESENTATIONS[i % 3]! }));
    const run = () => dealCastingTypes(new SeededRandom(99), 15, Array(15).fill(30), traits).map((t) => t.label);
    expect(run()).toEqual(run());
    let draws = 0; const inner = new SeededRandom(99);
    dealCastingTypes({ int: (n) => { draws++; return inner.int(n); } }, 15, Array(15).fill(30), traits);
    expect(draws).toBe(15);
  });

  it("without a presentation every type is equally likely and the label is the base one", () => {
    const out = dealCastingTypes(new SeededRandom(5), 15, Array(15).fill(40));
    for (const t of out) expect(t.label).toBe(CASTING_TYPES.find((x) => x.id === t.id)!.label);
  });

  it("a deal for a woman, a man and a nonbinary person of the same traits wears three labels of one type", () => {
    const t = CASTING_TYPES.find((x) => x.id === "parent-of-the-house")!;
    expect(castingLabelFor(t, "woman")).toBe("the mom of the house");
    expect(castingLabelFor(t, "man")).toBe("the dad of the house");
    expect(castingLabelFor(t, "nonbinary")).toBe("the parent of the house");
    expect(castingLabelFor(t, undefined)).toBe("the parent of the house");
  });

  it("recohere keeps a fitting type, relabels it for a changed presentation, and keeps the id", () => {
    const fox = CASTING_TYPES.find((x) => x.id === "silver-fox")!;
    const traits = [{ archetype: "mastermind", strategyStyle: "strategic", demeanor: "cool and clipped", genderPresentation: "woman" as const }];
    const r = recohereCastingTypes(new SeededRandom(hashSeed("1:casting-type")), [{ ...fox, label: "the silver fox" }], [50], traits);
    expect(r.types[0]!.id).toBe("silver-fox");
    expect(r.types[0]!.label).toBe("the silver vixen");
    expect(r.changed).toBe(0);
  });

  it("an old save keeps its stored label: the card check reads old and new labels to the same type", () => {
    for (const label of ["the showstopper", "the diva", "the distinguished one", "the silver fox", "the silver vixen"]) {
      expect(traitContradictions({ archetype: "analyst", strategyStyle: "strategic", demeanor: "quiet", castingType: { label } }), label).toEqual(
        label.includes("diva") || label.includes("showstopper") ? ["trait-casting-type"] : [],
      );
    }
  });

  it("zero trait contradictions over 200 seeded houses", () => {
    for (const seed of SEEDS500.slice(0, 200)) {
      const { npcs } = generateHouse(new SeededRandom(seed));
      const div = generateDiversityLayer(seed, npcs);
      for (const n of npcs) { n.character.genderPresentation = div.public[n.id]!.genderPresentation; n.character.age = div.public[n.id]!.age; }
      const layer = generateCastDeepLayer(seed, npcs);
      for (const n of npcs) {
        expect(traitContradictions({ archetype: n.character.archetype, strategyStyle: n.character.strategyStyle, demeanor: n.character.demeanor, castingType: layer.public[n.id]!.castingType }), `${seed} ${n.name}`).not.toContain("trait-casting-type");
      }
    }
  });
});
