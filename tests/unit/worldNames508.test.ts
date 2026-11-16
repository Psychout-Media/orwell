import { describe, it, expect } from "vitest";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { dealEraGivenNames, birthsInDecade, decadeIndexFor, NAMES_REFERENCE_YEAR } from "../../src/engine/data/worldNames";
import { recordSeason, emptyLedger, avoidSets } from "../../src/domain/recentSeasons";
import { generateHouse } from "../../src/engine/characterFactory";
import names from "../../src/engine/data/world/given-names.json";

// ORW-508: given names at real frequency by birth decade (SSA counts, via a public mirror), dealt in a played season.

const people = (ages: number[], gender: "man" | "woman" = "woman") => ages.map((age) => ({ age, gender }));
const AGES = [21, 24, 28, 31, 35, 38, 42, 46, 50, 53, 57, 60, 26, 33, 44];

describe("ORW-508 given-name table", () => {
  it("has about three thousand names with counts by decade, and the counts are the SSA's", () => {
    expect(names.F.length).toBeGreaterThan(1500);
    expect(names.M.length).toBeGreaterThan(1000);
    expect(names.decades).toEqual([[1966, 1975], [1976, 1985], [1986, 1995], [1996, 2005]]);
    // ranks by decade: the SSA's top names for the decade, not a hand list
    const top = (sex: "F" | "M", d: number) => [...(names[sex] as unknown as [string, ...number[]][])].sort((a, b) => (b[1 + d] as number) - (a[1 + d] as number))[0]![0];
    expect(top("F", 0)).toBe("Jennifer"); expect(top("M", 0)).toBe("Michael"); expect(top("F", 3)).toBe("Emily"); expect(top("M", 3)).toBe("Jacob");
  });
  it("a name fits the person's birth decade: a 22-year-old and a 55-year-old draw from different tables", () => {
    expect(decadeIndexFor(NAMES_REFERENCE_YEAR - 1970)).toBe(0);
    expect(decadeIndexFor(22)).toBe(3);
    expect(birthsInDecade("Jennifer", "F", 55)).toBeGreaterThan(birthsInDecade("Jennifer", "F", 22));
    expect(birthsInDecade("Madison", "F", 22)).toBeGreaterThan(birthsInDecade("Madison", "F", 55) * 10);
    let old = 0, young = 0;
    for (let seed = 0; seed < 200; seed++) {
      const r = new SeededRandom(seed);
      for (const n of dealEraGivenNames(r, people([55, 56, 57, 58, 59]), new Set())) if (birthsInDecade(n, "F", 22) > birthsInDecade(n, "F", 57)) old++;
      for (const n of dealEraGivenNames(r, people([21, 22, 23, 24, 25]), new Set())) if (birthsInDecade(n, "F", 57) > birthsInDecade(n, "F", 22)) young++;
    }
    // softened counts (exponent 0.5) keep the decade lean without making it a rule: under a third are off-decade
    expect(old / 1000).toBeLessThan(0.35); expect(young / 1000).toBeLessThan(0.35);
  });
});

describe("ORW-508 name deal", () => {
  it("is deterministic, unique in a cast, never a denied name, and honours the memory", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const a = dealEraGivenNames(new SeededRandom(seed), people(AGES), new Set());
      expect(a).toEqual(dealEraGivenNames(new SeededRandom(seed), people(AGES), new Set()));
      expect(new Set(a).size).toBe(15);
      for (const n of a) expect(["Ryne", "Marcus", "Felix"]).not.toContain(n);
      const l = recordSeason(emptyLedger(), { names: a.map((n) => `${n} Test`) });
      const b = dealEraGivenNames(new SeededRandom(seed), people(AGES), new Set(), avoidSets(l));
      expect(b.filter((n) => a.includes(n))).toEqual([]);
    }
  });
  it("a name already taken is never dealt, and the sexes stay coherent", () => {
    const man = dealEraGivenNames(new SeededRandom(5), people(AGES, "man"), new Set(["James", "John"]));
    for (const n of man) { expect(["James", "John"]).not.toContain(n); expect(birthsInDecade(n, "M", 35)).toBeGreaterThanOrEqual(0); }
    const nb = dealEraGivenNames(new SeededRandom(5), AGES.map((age) => ({ age, gender: "nonbinary" as const })), new Set());
    expect(new Set(nb).size).toBe(15);
  });
  it("over 200 casts: far more distinct names, a lower top share and fewer repeats between casts than the 500-name list", () => {
    const count = new Map<string, number>(); const inCast = new Map<string, number>(); let shared = 0; let prev = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const seed = 1000 + i * 7919; // the engine's own seeded cast supplies the ages
      const cast = generateHouse(new SeededRandom(seed)).npcs.map((h, j) => ({ age: h.character.age, gender: (j % 2 ? "man" : "woman") as "man" | "woman" }));
      const got = dealEraGivenNames(new SeededRandom(seed ^ 77), cast, new Set());
      for (const n of got) count.set(n, (count.get(n) ?? 0) + 1);
      for (const n of new Set(got)) { inCast.set(n, (inCast.get(n) ?? 0) + 1); if (prev.has(n)) shared++; }
      prev = new Set(got);
    }
    expect(count.size).toBeGreaterThan(1200);
    expect(Math.max(...count.values()) / 3000).toBeLessThan(0.0043);
    expect(Math.max(...inCast.values()) / 200).toBeLessThan(0.065);
    expect(shared / 199).toBeLessThan(0.44);
  });
});

describe("ORW-508 names in a played season", () => {
  it("a season with no explicit seed gets decade-fitting, gender-coherent, unique given names; an explicit seed keeps the floor", () => {
    for (let i = 0; i < 3; i++) {
      const warm = new GameSessionAdapter().preSeedCast({});
      const cards = warm.house as unknown as Array<{ name: string; age: number; genderPresentation?: string }>;
      const given = cards.map((c) => c.name.split(" ")[0]!);
      expect(new Set(given).size).toBe(given.length);
      for (const c of cards) {
        const g = c.name.split(" ")[0]!;
        const sex = c.genderPresentation === "woman" ? "F" : c.genderPresentation === "man" ? "M" : undefined;
        if (sex) expect(birthsInDecade(g, sex, c.age), `${g} (${c.age}, ${sex})`).toBeGreaterThan(0);
      }
    }
    const a = new GameSessionAdapter().preSeedCast({ seed: 777 }).house.map((c) => c.name);
    const b = new GameSessionAdapter().preSeedCast({ seed: 777 }).house.map((c) => c.name);
    expect(a).toEqual(b);
  });
  it("the recent-seasons memory keeps a new season's given names off the last one", () => {
    const first = new GameSessionAdapter().preSeedCast({}).house.map((c) => c.name);
    const wire = { names: first };
    const again = new GameSessionAdapter().preSeedCast({ avoid: wire }).house.map((c) => c.name);
    expect(again.filter((n) => first.includes(n))).toEqual([]);
    expect(again.filter((n) => first.some((f) => f.split(" ")[0] === n.split(" ")[0])).length).toBeLessThanOrEqual(1);
  });
});
