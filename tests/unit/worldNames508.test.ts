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
    // real frequency leans toward common names (exponent 0.6): a little more top-name share than a flat list, far fewer repeats
    expect(Math.max(...count.values()) / 3000).toBeLessThan(0.0065);
    expect(Math.max(...inCast.values()) / 200).toBeLessThan(0.09);
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

import { dealSurnames } from "../../src/engine/data/worldNames";
import surnamesJson from "../../src/engine/data/world/surnames.json";

describe("ORW-508 surnames at Census frequency", () => {
  it("the table is the Census 2010 surnames: about five thousand names, the published Smith count, plain single words", () => {
    const rows = surnamesJson.rows as unknown as Array<[string, number]>;
    expect(rows.length).toBeGreaterThan(4500);
    expect(rows[0]!.slice(0, 2)).toEqual(["Smith", 2442977]);
    for (const [n] of rows) expect(n, n).toMatch(/^[A-Z][a-zA-Z]{2,11}$/);
    expect(rows.some(([n]) => n === "McDonald")).toBe(true);
  });
  it("is deterministic, unique in a cast, and off the memory; far wider than the 805-name list", () => {
    const count = new Map<string, number>(); const inCast = new Map<string, number>(); let shared = 0; let prev = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const seed = 1000 + i * 7919;
      const a = dealSurnames(new SeededRandom(seed), 15, new Set());
      expect(a).toEqual(dealSurnames(new SeededRandom(seed), 15, new Set()));
      expect(new Set(a.map((x) => x.toLowerCase())).size).toBe(15);
      const l = recordSeason(emptyLedger(), { names: a.map((s) => `Pat ${s}`) });
      expect(dealSurnames(new SeededRandom(seed), 15, new Set(), avoidSets(l)).filter((s) => a.includes(s))).toEqual([]);
      for (const s of a) count.set(s, (count.get(s) ?? 0) + 1);
      for (const s of new Set(a)) { inCast.set(s, (inCast.get(s) ?? 0) + 1); if (prev.has(s)) shared++; }
      prev = new Set(a);
    }
    expect(count.size).toBeGreaterThan(1500);
    expect(Math.max(...count.values()) / 3000).toBeLessThan(0.005);
    expect(Math.max(...inCast.values()) / 200).toBeLessThan(0.07);
    expect(shared / 199).toBeLessThan(0.29);
  });
  it("a played season's surnames are Census names, unique, and off the last season", () => {
    const set = new Set((surnamesJson.rows as unknown as Array<[string, number]>).map((r) => r[0]));
    const first = new GameSessionAdapter().preSeedCast({}).house.map((c) => c.name);
    for (const n of first) expect(set.has(n.split(" ").slice(1).join(" ")), n).toBe(true);
    expect(new Set(first.map((n) => n.split(" ").slice(1).join(" "))).size).toBe(first.length);
    const again = new GameSessionAdapter().preSeedCast({ avoid: { names: first } }).house.map((c) => c.name);
    expect(again.filter((n) => first.some((f) => f.split(" ").slice(1).join(" ") === n.split(" ").slice(1).join(" ")))).toEqual([]);
  });
});

import { censusGroupOfHeritage } from "../../src/engine/data/worldNames";
import { JOB_INDEX } from "../../src/engine/data/worldJobs";

describe("ORW-508 surnames fit the person's heritage (Census race and origin shares)", () => {
  const rows = surnamesJson.rows as unknown as Array<[string, number, number, number, number, number, number]>;
  const share = (n: string, col: number) => rows.find((r) => r[0] === n)![col] as number;
  it("maps each heritage label to a Census group, or none", () => {
    expect(censusGroupOfHeritage("Korean American")).toBe("api");
    expect(censusGroupOfHeritage("Mexican American")).toBe("hispanic");
    expect(censusGroupOfHeritage("Black American")).toBe("black");
    expect(censusGroupOfHeritage("German American")).toBe("white");
    expect(censusGroupOfHeritage("multiracial")).toBeUndefined();
    expect(censusGroupOfHeritage(undefined)).toBeUndefined();
  });
  it("a Vietnamese or Mexican American is dealt a surname that group actually carries", () => {
    const draw = (g: "api" | "hispanic" | "black" | "white", col: number) => {
      let fit = 0, total = 0;
      for (let seed = 0; seed < 80; seed++) for (const s of dealSurnames(new SeededRandom(seed), 15, new Set(), undefined, Array(15).fill(g))) { total++; if (share(s, col) >= 30) fit++; }
      return fit / total;
    };
    // against about 3 percent (api) and 10 to 20 percent (hispanic, black) from the national table, which ignores heritage
    expect(draw("api", 4)).toBeGreaterThan(0.6);
    expect(draw("hispanic", 6)).toBeGreaterThan(0.8);
    expect(draw("black", 3)).toBeGreaterThan(0.3);
    expect(draw("white", 2)).toBeGreaterThan(0.9);
  });
  it("a played season's cast has surnames that fit each houseguest's ethnicity facet", () => {
    let fit = 0, total = 0;
    for (let i = 0; i < 20; i++) {
      for (const c of new GameSessionAdapter().preSeedCast({}).house as unknown as Array<{ name: string; ethnicity?: string }>) {
        const g = censusGroupOfHeritage(c.ethnicity); if (!g) continue;
        const col = { white: 2, black: 3, api: 4, aian: 5, hispanic: 6 }[g];
        const r = rows.find((x) => x[0] === c.name.split(" ").slice(1).join(" "))!; total++;
        if ((r[col] as number) >= 20) fit++;
      }
    }
    expect(fit / total).toBeGreaterThan(0.8);
  });
});

describe("ORW-508 an adopted warm cast never shares the player's name", () => {
  it("a player named after a houseguest (given name or surname) leaves no houseguest with it", () => {
    for (let i = 0; i < 6; i++) {
      const s = new GameSessionAdapter();
      const warm = s.preSeedCast({}).house as unknown as Array<{ name: string }>;
      const [g, ...rest] = warm[i]!.name.split(" ");
      const player = i % 2 === 0 ? `${g} Zzyzx` : `Zzyzxa ${rest.join(" ")}`;
      s.createCharacter({ playerName: player });
      const house = s.getGameState().house.filter((h) => h.status === "active");
      expect(house.length).toBe(15);
      const [pg, ...pr] = player.split(" ");
      for (const h of house) {
        const [hg, ...hr] = h.name.split(" ");
        expect(hg.toLowerCase(), `${h.name} vs ${player}`).not.toBe(pg!.toLowerCase());
        expect(hr.join(" ").toLowerCase()).not.toBe(pr.join(" ").toLowerCase());
      }
    }
  });
});

describe("ORW-508 physicians and surgeons are not in their twenties", () => {
  it("floors follow residency and fellowship", () => {
    expect(JOB_INDEX.get("family medicine physician")!.minAge).toBeGreaterThanOrEqual(29);
    expect(JOB_INDEX.get("cardiologist")!.minAge).toBeGreaterThanOrEqual(32);
    expect(JOB_INDEX.get("pediatric surgeon")!.minAge).toBeGreaterThanOrEqual(33);
    expect(JOB_INDEX.get("lawyer")!.minAge).toBeGreaterThanOrEqual(26);
    for (const [job, row] of JOB_INDEX) if (row.group === "29" && /physician|surgeon|cardiolog|psychiatr|radiolog|anesthesiolog|dermatolog|neurolog|pediatrician|obstetric/.test(job) && !/nurse|assistant|technolog|technician/.test(job)) expect(row.minAge, job).toBeGreaterThanOrEqual(29);
  });
});
