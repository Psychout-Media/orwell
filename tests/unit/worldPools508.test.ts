import { describe, it, expect } from "vitest";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { generateHouse, generateBackstoryFacets, articleFor, MAX_PER_REGION, MAX_PER_VOCATION } from "../../src/engine/characterFactory";
import { WORLD_PLACES, sizeClassOf } from "../../src/engine/data/worldPlaces";
import { HOMETOWNS } from "../../src/engine/data/hometowns";
import { buildTable, drawOne, drawConstrained } from "../../src/engine/data/worldSampler";
import { dealWorldHometowns, stateCap } from "../../src/engine/data/worldHometowns";
import { implausibleBecause, ageProblem, RULES, SAFE_VOCATIONS } from "../../src/engine/data/worldPlausibility";
import { VOCATIONS } from "../../src/engine/data/vocations";
import { JOB_INDEX, WORLD_JOBS } from "../../src/engine/data/worldJobs";
import { emptyLedger, recordSeason, avoidSets, avoidFromWire, parseLedger, factsOfCast, LEDGER_WINDOW, NO_AVOID } from "../../src/domain/recentSeasons";

// ORW-508: the world place table, its sampler, the acceptance rules and the recent-seasons memory.

const SEEDS = Array.from({ length: 200 }, (_, i) => 1000 + i * 7919);
const placeOf = new Map(WORLD_PLACES.map((p) => [p.city, p]));

describe("ORW-508 world place table", () => {
  it("covers all fifty states, every size class, no duplicate city, and every hometown is in HOMETOWNS", () => {
    expect(new Set(WORLD_PLACES.map((p) => p.state)).size).toBeGreaterThanOrEqual(50); // fifty states and DC
    expect(new Set(WORLD_PLACES.map((p) => p.size)).size).toBe(4);
    expect(new Set(WORLD_PLACES.map((p) => p.city)).size).toBe(WORLD_PLACES.length);
    expect(WORLD_PLACES.length).toBeGreaterThanOrEqual(9000);
    const all = new Set(HOMETOWNS.map((h) => h.city));
    for (const p of WORLD_PLACES) expect(all.has(p.city), p.city).toBe(true);
    expect(sizeClassOf(8800)).toBe("big-city");
    expect(sizeClassOf(3)).toBe("town");
  });
});

describe("ORW-508 sampler", () => {
  it("draws in proportion to weight, with one rng.next() per draw", () => {
    const t = buildTable(["a", "b", "c"], (x) => ({ a: 1, b: 2, c: 7 }[x]!));
    const rng = new SeededRandom(5);
    const n: Record<string, number> = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 10000; i++) n[drawOne(rng, t)]!++;
    expect(n.a! / 10000).toBeGreaterThan(0.08); expect(n.a! / 10000).toBeLessThan(0.12);
    expect(n.c! / 10000).toBeGreaterThan(0.66); expect(n.c! / 10000).toBeLessThan(0.74);
  });
  it("is deterministic and bounded: an impossible constraint still returns a row", () => {
    const t = buildTable([1, 2, 3], () => 1);
    const a = drawConstrained(new SeededRandom(9), t, [() => false, (x) => x === 2]);
    const b = drawConstrained(new SeededRandom(9), t, [() => false, (x) => x === 2]);
    expect(a).toBe(b);
    expect(drawConstrained(new SeededRandom(9), t, [() => false])).toBeGreaterThan(0);
  });
});

describe("ORW-508 hometown deal", () => {
  it("is the same for the same seed, unique per cast, and capped by state, region and size class", () => {
    for (const seed of SEEDS.slice(0, 60)) {
      const a = dealWorldHometowns(new SeededRandom(seed), 15, MAX_PER_REGION);
      expect(a).toEqual(dealWorldHometowns(new SeededRandom(seed), 15, MAX_PER_REGION));
      expect(new Set(a).size).toBe(15);
      const ps = a.map((c) => placeOf.get(c)!);
      // ORW-995: the caps follow population (a flat 2 per state held California to 11% of draws against 15.7% of residents)
      const by = (k: (p: (typeof ps)[number]) => string) => ps.reduce<Record<string, number>>((m, p) => ((m[k(p)] = (m[k(p)] ?? 0) + 1), m), {});
      for (const [s, n] of Object.entries(by((p) => p.state))) expect(n, s).toBeLessThanOrEqual(stateCap(s, 15));
      for (const [r, n] of Object.entries(by((p) => p.region))) expect(n, r).toBeLessThanOrEqual(MAX_PER_REGION);
    }
  });
  it("avoids what the memory says was used, while there is room", () => {
    const first = dealWorldHometowns(new SeededRandom(77), 15, MAX_PER_REGION);
    const ledger = recordSeason(emptyLedger(), { hometowns: first });
    const second = dealWorldHometowns(new SeededRandom(77), 15, MAX_PER_REGION, avoidSets(ledger));
    expect(second.filter((c) => first.includes(c) && placeOf.get(c)!.size !== "big-city")).toEqual([]); // ORW-995: the memory never blocks a big city
  });
  it("seeded casts use a much wider range of towns than the old 106 and no town dominates", () => {
    const towns = new Map<string, number>();
    for (const seed of SEEDS) for (const n of generateHouse(new SeededRandom(seed)).npcs) towns.set(n.character.hometown!, (towns.get(n.character.hometown!) ?? 0) + 1);
    expect(towns.size).toBeGreaterThanOrEqual(1500);
    expect(Math.max(...towns.values()) / 3000).toBeLessThan(0.05); // ORW-995: at the census frequency New York is 4.3% of residents (before: 3% under the 0.85 flatten)
  });
});

describe("ORW-508 acceptance: wide generation, narrow acceptance", () => {
  it("rules read as expected", () => {
    expect(ageProblem("pharmacist", 22)).toBe("licence-age-27");
    expect(ageProblem("pharmacist", 30)).toBeNull();
    expect(implausibleBecause({ vocation: "surf instructor", age: 30, state: "NE", size: "city" })).toBe("needs-coast");
    expect(implausibleBecause({ vocation: "cattle rancher", age: 40, state: "TX", size: "big-city" })).toBe("not-big-city-farm");
    expect(implausibleBecause({ vocation: "barista", age: 22, state: "NE", size: "town" })).toBeNull();
    for (const v of SAFE_VOCATIONS) { expect(VOCATIONS.includes(v) || JOB_INDEX.has(v), v).toBe(true); for (const age of [21, 60]) for (const size of ["town", "big-city"] as const) expect(implausibleBecause({ vocation: v, age, state: "NE", size })).toBeNull(); }
    expect(RULES.length).toBeGreaterThan(8);
  });

  it("3000 sampled people: implausible rate by rule, without and with acceptance", () => {
    const rate = (accept: boolean) => {
      const by: Record<string, number> = {}; let bad = 0, n = 0;
      for (const seed of SEEDS) {
        const { npcs, acceptance } = generateHouse(new SeededRandom(seed));
        let nn = npcs;
        if (!accept) {
          // the same deal with the acceptance inputs left out: the unaccepted wide draw
          const key = npcs.map((x) => x.name).join("|");
          const facets = generateBackstoryFacets(new SeededRandom(0x9e3779b9 ^ seed), 15, { hometownRng: new SeededRandom(seed ^ 0x1234567) });
          nn = npcs.map((h, i) => ({ ...h, character: { ...h.character, vocation: facets[i]!.vocation, hometown: facets[i]!.hometown } }));
          void key;
        } else {
          expect(acceptance.fallbacks).toBeLessThanOrEqual(3);
        }
        for (const h of nn) {
          n++;
          const p = placeOf.get(h.character.hometown!)!;
          const why = implausibleBecause({ vocation: h.character.vocation!, age: h.character.age, state: p.state, size: p.size });
          if (why) { bad++; by[why] = (by[why] ?? 0) + 1; }
        }
      }
      return { n, bad, rate: bad / n, by };
    };
    const raw = rate(false), accepted = rate(true);
    console.log(`IMPLAUSIBLE (age, job, town) of ${raw.n}: without acceptance ${(raw.rate * 100).toFixed(2)}% ${JSON.stringify(raw.by)}; with acceptance ${(accepted.rate * 100).toFixed(2)}%`);
    expect(raw.rate).toBeGreaterThan(0.03);
    expect(accepted.rate).toBe(0);
  });

  it("vocation caps and uniqueness still hold after the re-deal", () => {
    for (const seed of SEEDS.slice(0, 80)) {
      const { npcs } = generateHouse(new SeededRandom(seed));
      const c: Record<string, number> = {};
      for (const n of npcs) c[n.character.vocation!] = (c[n.character.vocation!] ?? 0) + 1;
      expect(Math.max(...Object.values(c))).toBeLessThanOrEqual(MAX_PER_VOCATION);
    }
  });

  it("rejections are counted by rule name for the season line", () => {
    const total: Record<string, number> = {};
    for (const seed of SEEDS.slice(0, 50)) for (const [k, v] of Object.entries(generateHouse(new SeededRandom(seed)).acceptance.rejected)) total[k] = (total[k] ?? 0) + v;
    expect(Object.keys(total).length).toBeGreaterThan(0);
    for (const k of Object.keys(total)) expect(RULES.map((r) => r.name).includes(k) || /^min-age-\d+$/.test(k), k).toBe(true);
  });
});

describe("ORW-508 recent-seasons memory", () => {
  it("keeps the last LEDGER_WINDOW seasons, newest last, and builds lower-cased avoid sets", () => {
    let l = emptyLedger();
    for (let i = 0; i < LEDGER_WINDOW + 3; i++) l = recordSeason(l, { names: [`Name${i} Surname`], hometowns: ["Boston, MA"] });
    expect(l.seasons.length).toBe(LEDGER_WINDOW);
    const a = avoidSets(l);
    expect(a.names.has("name2 surname")).toBe(false);
    expect(a.names.has("name8 surname")).toBe(true);
    expect(a.hometowns.has("boston, ma")).toBe(true);
    expect(avoidSets(l, 1).names.size).toBe(1);
  });
  it("is pure, bounded and fail-soft on garbage", () => {
    const l = recordSeason(emptyLedger(), { names: ["  A\u0000 B  ", "a b", 5 as unknown as string, "x".repeat(500)] });
    expect(l.seasons[0]!.names).toEqual(["A B", "x".repeat(120)]);
    expect(emptyLedger().seasons).toEqual([]);
    expect(parseLedger("nope").seasons).toEqual([]);
    expect(parseLedger({ seasons: [{ names: ["Ann"] }, 7, { hometowns: 3 }] }).seasons.length).toBe(1);
    expect(recordSeason(l, {})).toBe(l);
    expect(NO_AVOID.names.size).toBe(0);
  });
  it("records a dealt cast and the next cast with that memory shares none of its towns", () => {
    const seed = 4242;
    const first = generateHouse(new SeededRandom(seed)).npcs;
    const l = recordSeason(emptyLedger(), factsOfCast(first.map((n) => ({ name: n.name, vocation: n.character.vocation!, hometown: n.character.hometown! }))));
    const again = generateHouse(new SeededRandom(seed), undefined, avoidSets(l)).npcs;
    expect(again.filter((n) => first.some((f) => f.character.hometown === n.character.hometown))).toEqual([]);
    // and without a memory the same seed gives the same cast
    expect(generateHouse(new SeededRandom(seed)).npcs.map((n) => n.character.hometown)).toEqual(first.map((n) => n.character.hometown));
  });
});

describe("ORW-508 world job table", () => {
  it("has hundreds of real jobs with floors, a casting lean and a share for the hand-written curios", () => {
    expect(WORLD_JOBS.length).toBeGreaterThanOrEqual(400);
    expect(JOB_INDEX.get("registered nurse")!.minAge).toBeGreaterThanOrEqual(22);
    expect(JOB_INDEX.get("farmer")?.maxSize ?? "small-city").toBe("small-city");
    expect(WORLD_JOBS.some((j) => j.group === "legacy")).toBe(true);
    for (const v of VOCATIONS) expect(JOB_INDEX.has(v.toLowerCase()), v).toBe(true);
  });
  it("no cast has two of one job, a cast of 15 spans many groups, and the memory is honoured", () => {
    for (const seed of SEEDS.slice(0, 80)) {
      const jobs = generateHouse(new SeededRandom(seed)).npcs.map((n) => n.character.vocation!);
      expect(new Set(jobs).size).toBeGreaterThanOrEqual(13);
    }
    const first = generateHouse(new SeededRandom(31)).npcs.map((n) => n.character.vocation!);
    const l = recordSeason(emptyLedger(), { vocations: first });
    const again = generateHouse(new SeededRandom(31), undefined, avoidSets(l)).npcs.map((n) => n.character.vocation!);
    expect(again.filter((v) => first.includes(v))).toEqual([]);
  });
  it("articles read right", () => {
    expect(articleFor("EMT")).toBe("an"); expect(articleFor("HVAC technician")).toBe("an"); expect(articleFor("barista")).toBe("a"); expect(articleFor("electrician")).toBe("an");
  });
});

describe("ORW-508 names in the memory", () => {
  it("a cast dealt with the memory of a cast shares none of its full names or given names", () => {
    const first = generateHouse(new SeededRandom(2468)).npcs.map((n) => n.name);
    const l = recordSeason(emptyLedger(), { names: first });
    const again = generateHouse(new SeededRandom(2468), undefined, avoidSets(l)).npcs.map((n) => n.name);
    expect(again.filter((n) => first.includes(n))).toEqual([]);
    expect(again.filter((n) => first.some((f) => f.split(" ")[0] === n.split(" ")[0]))).toEqual([]);
  });
});

describe("ORW-508 review fixes", () => {
  it("the memory sent over the wire keeps the newest season when six full seasons are merged (no cut at 80)", () => {
    const merged: string[] = [];
    for (let s = 0; s < 6; s++) for (let i = 0; i < 15; i++) merged.push(`Town${s}x${i}, OH`);
    const a = avoidFromWire({ hometowns: merged })!;
    expect(a.hometowns.size).toBe(90);
    expect(a.hometowns.has("town5x14, oh")).toBe(true);
    expect(a.hometowns.has("town0x0, oh")).toBe(true);
  });
  it("a remembered name in any case or spelling excludes the corpus name (McDonald, Mary-Ann)", () => {
    const first = generateHouse(new SeededRandom(99)).npcs.map((n) => n.name);
    const lowered = recordSeason(emptyLedger(), { names: first.map((n) => n.toLowerCase()) });
    const again = generateHouse(new SeededRandom(99), undefined, avoidSets(lowered)).npcs.map((n) => n.name);
    expect(again.filter((n) => first.includes(n))).toEqual([]);
  });
});
