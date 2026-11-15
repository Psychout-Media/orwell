import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { generateHouse } from "../../src/engine/characterFactory";
import {
  generateCastDeepLayer, dealCastPhysicalSpread, dealBuildBands, buildBandOf, BUILD_WORDS, dealHairSpread, dealMarksSpread, ageLookFor, HAIR_DESC, isGrayHair,
} from "../../src/engine/deepProfile";
import { CASTING_TYPES, dealCastingTypes } from "../../src/domain/castingTypes";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";
import type { UserSaveStore } from "../../src/ports/UserSaveStore";
import type { RandomnessSource } from "../../src/ports/RandomnessSource";

// ORW-381: character-creation looks are cast for television: hair by age (no repeats), marks as signatures.

const SEEDS = Array.from({ length: 40 }, (_, i) => 7 + i * 173);
const castOf = (seed: number) => {
  const { npcs } = generateHouse(new SeededRandom(seed));
  const layer = generateCastDeepLayer(seed, npcs);
  return npcs.map((n) => ({ age: n.character.age, pc: layer.public[n.id]!.physicalCharacteristics }));
};

describe("ORW-381 hair by age", () => {
  it("has at least 24 entries and 3-4 gray/silver/salt-and-pepper ones, none with a condition word", () => {
    expect(HAIR_DESC.length).toBeGreaterThanOrEqual(24);
    const gray = HAIR_DESC.filter(isGrayHair);
    expect(gray.length).toBeGreaterThanOrEqual(3);
    expect(gray.length).toBeLessThanOrEqual(4);
    for (const h of HAIR_DESC) expect(h).not.toMatch(/messy|frayed|unruly|scruffy|greasy|thinning|balding/i);
  });

  it("over 40 seeds: no gray hair under 40 and 15 different hair entries per cast", () => {
    for (const seed of SEEDS) {
      const cast = castOf(seed);
      expect(cast.length).toBe(15);
      for (const { age, pc } of cast) if (age < 40) expect(isGrayHair(pc.hair), `${seed}: age ${age} ${pc.hair}`).toBe(false);
      expect(new Set(cast.map((c) => c.pc.hair)).size, `seed ${seed}`).toBe(15);
    }
  });
});

describe("ORW-381 marks are signatures", () => {
  it("no MARKS entry is a scar, birthmark or chipped tooth, and none is dealt twice", () => {
    for (const seed of SEEDS) {
      const marks = castOf(seed).map((c) => c.pc.distinguishingMark);
      for (const m of marks) expect(m).not.toMatch(/scar|birthmark|chipped/i);
      const named = marks.filter((m) => !/^none\b/i.test(m));
      expect(new Set(named).size).toBe(named.length);
    }
  });

  it("tattoo marks are a small minority: at most 2 per cast (the two tattoo entries, each once)", () => {
    for (const seed of [2026, 77, 4242, 999, 108108, ...SEEDS]) {
      const marks = dealCastPhysicalSpread(new SeededRandom(seed), 15).map((x) => x.mark);
      expect(marks.filter((m) => /tattoo/i.test(m)).length).toBeLessThanOrEqual(2);
      const named = marks.filter((m) => !/^none\b/i.test(m));
      expect(new Set(named).size).toBe(named.length);
    }
  });

  it("7-11 of 15 are 'none notable' in at least 36 of 40 seeds", () => {
    let ok = 0;
    for (const seed of SEEDS) {
      const none = castOf(seed).filter((c) => /^none\b/i.test(c.pc.distinguishingMark)).length;
      if (none >= 7 && none <= 11) ok++;
    }
    expect(ok).toBeGreaterThanOrEqual(36);
  });
});

describe("ORW-381 age looks", () => {
  it("each band reads as specified and nothing says weathered", () => {
    expect(ageLookFor(22)).toBe("fresh, early-twenties energy");
    expect(ageLookFor(28)).toBe("bright, late-twenties look");
    expect(ageLookFor(35)).toBe("polished, thirties poise");
    expect(ageLookFor(45)).toBe("fit and well-kept, forties ease, a few laugh lines");
    expect(ageLookFor(55)).toBe("distinguished, fit fifties, laugh lines and presence");
    for (let a = 18; a < 90; a++) expect(ageLookFor(a)).not.toMatch(/weathered/i);
    for (const seed of SEEDS.slice(0, 10)) for (const c of castOf(seed)) {
      expect(JSON.stringify(c.pc)).not.toMatch(/weathered/i);
    }
  });
});

describe("ORW-381 side stream draws", () => {
  const counting = (seed: number) => {
    const inner = new SeededRandom(seed);
    let draws = 0;
    const rng: RandomnessSource = {
      next: () => { draws++; return inner.next(); },
      int: (n) => { draws++; return inner.int(n); },
      pick: (items) => { draws++; return inner.pick(items); },
      fork: (l) => inner.fork(l),
    };
    return { rng, draws: () => draws };
  };

  it("hair and marks take exactly one draw per houseguest, whatever the ages or seed", () => {
    for (const seed of SEEDS) {
      for (const ages of [Array(15).fill(22), Array(15).fill(55), Array.from({ length: 15 }, (_, i) => 20 + i * 3)]) {
        const h = counting(seed);
        expect(dealHairSpread(h.rng, 15, ages, 1).length).toBe(15);
        expect(h.draws()).toBe(15);
        const m = counting(seed);
        expect(dealMarksSpread(m.rng, 15, 1).length).toBe(15);
        expect(m.draws()).toBe(15);
      }
    }
  });

  it("ages do not change how much of the side stream is consumed", () => {
    const young = counting(5), old = counting(5);
    dealCastPhysicalSpread(young.rng, 15, undefined, Array(15).fill(22));
    dealCastPhysicalSpread(old.rng, 15, undefined, Array(15).fill(60));
    expect(young.draws()).toBe(old.draws());
  });
});

describe("ORW-381 no main-stream draw moved", () => {
  it("the cast (names, ages, stats), hidden profiles and threads are byte-identical to before ORW-381 (hash taken on origin/main 0697c631)", () => {
    // Everything except the seven physical look fields, over six seeds. The look deal runs on its own side
    // stream, so this hash was identical before and after the change.
    let all = "";
    for (const seed of [1, 2, 3, 77, 2026, 4242]) {
      const { npcs } = generateHouse(new SeededRandom(seed));
      const l = generateCastDeepLayer(seed, npcs);
      const pub = Object.fromEntries(Object.entries(l.public).map(([k, v]) => [k, { biography: v.biography, physicalCharacteristics: 0 }]));
      all += JSON.stringify([npcs, pub, l.hidden, l.threads]);
    }
    expect(createHash("sha256").update(all).digest("hex")).toBe("0f66a3cd6e2760296d059db5a9f599b984d924d9a84a64cb4fd149b8aa3fb879");
  });
});

describe("ORW-381 casting type", () => {
  it("the list has at least 22 gender-neutral entries with short camera-visible reads", () => {
    expect(CASTING_TYPES.length).toBeGreaterThanOrEqual(22);
    expect(new Set(CASTING_TYPES.map((t) => t.id)).size).toBe(CASTING_TYPES.length);
    for (const t of CASTING_TYPES) {
      const words = t.read.split(/\s+/).length;
      expect(words, t.id).toBeGreaterThanOrEqual(3);
      expect(words, t.id).toBeLessThanOrEqual(10);
      expect(`${t.label} ${t.read}`, t.id).not.toMatch(/\b(he|she|his|her|man|woman|guy|girl|boy|handsome|beautiful)\b/i);
    }
    expect(CASTING_TYPES.find((t) => t.id === "silver-fox")!.minAge).toBe(45);
    expect(CASTING_TYPES.find((t) => t.id === "parent-of-the-house")!.minAge).toBe(36);
    expect(CASTING_TYPES.find((t) => t.id === "wise-head")!.maxAge).toBe(30);
  });

  it("over 40 seeds every 15-cast has 15 different types, each inside its age band", () => {
    for (const seed of SEEDS) {
      const { npcs } = generateHouse(new SeededRandom(seed));
      const layer = generateCastDeepLayer(seed, npcs);
      const types = npcs.map((n) => layer.public[n.id]!.castingType);
      expect(new Set(types.map((t) => t.id)).size, `seed ${seed}`).toBe(npcs.length);
      npcs.forEach((n, i) => {
        const t = types[i]!, a = n.character.age;
        if (t.minAge !== undefined) expect(a, `${seed} ${t.id}`).toBeGreaterThanOrEqual(t.minAge);
        if (t.maxAge !== undefined) expect(a, `${seed} ${t.id}`).toBeLessThanOrEqual(t.maxAge);
      });
    }
  });

  it("takes one draw per houseguest on its own stream and ignores everything but age", () => {
    let draws = 0;
    const inner = new SeededRandom(9);
    dealCastingTypes({ int: (n) => { draws++; return inner.int(n); } }, 15, Array(15).fill(30));
    expect(draws).toBe(15);
  });

  it("is on the public card (preSeedCast roster and the live house) and persists on the character", () => {
    const warm = new GameSessionAdapter().preSeedCast({ seed: 4321 });
    expect(warm.house.length).toBeGreaterThan(10);
    for (const c of warm.house) {
      expect(typeof c.castingType?.label).toBe("string");
      expect(typeof c.castingType?.read).toBe("string");
      expect(Object.keys(c.castingType!).sort()).toEqual(["label", "read"]);
    }
    const adapter = new GameSessionAdapter();
    const view = adapter.createCharacter({ playerName: "The Player", seed: 4321 });
    const labels = (view.house as ReadonlyArray<{ castingType?: { label: string } }>).map((h) => h.castingType?.label);
    expect(labels.every((l) => typeof l === "string")).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("a save from before ORW-381 (no castingType) loads unchanged, with the field still absent", () => {
    class Store implements UserSaveStore {
      saved: SessionSnapshot[] = [];
      saveFor(_u: string, s: SessionSnapshot): void { this.saved.push(s); }
      hasSave(): boolean { return this.saved.length > 0; }
      loadLatest(): SessionSnapshot | null { return this.saved.at(-1) ?? null; }
    }
    const boot = (store: Store) => {
      const reg = new GameSessionRegistry(store);
      new Orchestrator(reg, { now: () => 6102 }, { seed: 6102 });
      return reg.sandboxFor("u");
    };
    const store = new Store();
    const a = boot(store);
    a.session.createCharacter({ playerName: "The Player", seed: 6102 });
    a.session.advanceGame();
    expect(a.session.snapshot().house!.npcs.every((n) => n.character.castingType !== undefined)).toBe(true);
    const old = JSON.parse(JSON.stringify(store.loadLatest())) as SessionSnapshot;
    for (const n of old.house!.npcs) delete (n.character as { castingType?: unknown }).castingType;
    const store2 = new Store();
    store2.saved.push(old);
    const b = boot(store2);
    const npcs = b.session.snapshot().house!.npcs;
    expect(npcs.length).toBeGreaterThan(10);
    expect(npcs.every((n) => n.character.castingType === undefined)).toBe(true);
  });
});

describe("ORW-381 build leans to the physical stat", () => {
  it("each band has at least 4 neutral entries and none is unflattering", () => {
    const by = { athletic: 0, average: 0, soft: 0 };
    for (const w of BUILD_WORDS) {
      by[buildBandOf(w)!]++;
      expect(w).not.toMatch(/gone soft|flabby|heavy|overweight|frail|willowy/i);
    }
    expect(by.athletic).toBeGreaterThanOrEqual(4);
    expect(by.average).toBeGreaterThanOrEqual(4);
    expect(by.soft).toBeGreaterThanOrEqual(4);
  });

  it("takes one build-band draw per houseguest", () => {
    let draws = 0;
    const inner = new SeededRandom(3);
    dealBuildBands({ ...inner, int: (n: number) => { draws++; return inner.int(n); } } as unknown as RandomnessSource, [0.2, 0.5, 0.9]);
    expect(draws).toBe(3);
  });

  it("over 400+ seeded houseguests athletic builds are at least 3x as common in the top stat third as the bottom, and every band shows in every third", () => {
    const rows: { stat: number; band: string }[] = [];
    for (let i = 0; i < 200; i++) {
      const seed = 31 + i * 97;
      const { npcs } = generateHouse(new SeededRandom(seed));
      const layer = generateCastDeepLayer(seed, npcs);
      for (const n of npcs) rows.push({ stat: n.character.stats.physical, band: buildBandOf(layer.public[n.id]!.physicalCharacteristics.heightBuild)! });
    }
    expect(rows.length).toBeGreaterThanOrEqual(400);
    rows.sort((a, b) => a.stat - b.stat);
    const t = Math.floor(rows.length / 3);
    const thirds = [rows.slice(0, t), rows.slice(t, 2 * t), rows.slice(2 * t)];
    const count = (r: typeof rows, b: string) => r.filter((x) => x.band === b).length;
    const dist = thirds.map((r) => ({ athletic: count(r, "athletic"), average: count(r, "average"), soft: count(r, "soft") }));
    console.log("BUILD DISTRIBUTION (bottom, middle, top third)", JSON.stringify(dist));
    expect(dist[2]!.athletic).toBeGreaterThanOrEqual(3 * Math.max(1, dist[0]!.athletic));
    for (const d of dist) { expect(d.athletic).toBeGreaterThan(0); expect(d.average).toBeGreaterThan(0); expect(d.soft).toBeGreaterThan(0); }
  });

  it("the public card and the portrait prompt of a seeded cast carry no float and no stat key", () => {
    const warm = new GameSessionAdapter().preSeedCast({ seed: 8123 });
    const json = JSON.stringify(warm.house);
    expect(json).not.toMatch(/\b(physical|mental|social)"\s*:\s*[0-9.]+/);
    expect(json).not.toMatch(/\d\.\d/);
    expect(json).not.toMatch(/"(stats|band|buildBand|fitness)"/i);
    const view = new GameSessionAdapter().createCharacter({ playerName: "The Player", seed: 8123 });
    const hv = JSON.stringify(view.house);
    expect(hv).not.toMatch(/"(stats|buildBand|fitnessBand|band)"/i);
    expect(hv).not.toMatch(/"(physical|mental|social)"\s*:\s*[0-9]/);
    for (const c of warm.house) expect(BUILD_WORDS).toContain(c.physicalCharacteristics!.heightBuild);
  });
});
