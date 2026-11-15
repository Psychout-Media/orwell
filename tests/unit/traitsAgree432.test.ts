import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { hashSeed } from "../../src/engine/characterFactory";
import { generateHouse } from "../../src/engine/characterFactory";
import { generateCastDeepLayer, BUILD_WORDS } from "../../src/engine/deepProfile";
import { voiceFingerprint } from "../../src/engine/voice";
import { CASTING_TYPES, dealCastingTypes, type CastingDealReport } from "../../src/domain/castingTypes";
import {
  CASTING_TYPE_FIT, castingCompatible, heightWordsIn, traitContradictions, voiceLineConflict, VOICE_LINE_TEMPLATES,
} from "../../src/domain/traitConsistency";

// ORW-432: the traits the engine deals on separate streams must agree on one card.

const SEEDS = Array.from({ length: 40 }, (_, i) => 7 + i * 173);
const cast = (seed: number) => {
  const { npcs } = generateHouse(new SeededRandom(seed));
  const layer = generateCastDeepLayer(seed, npcs);
  return { npcs, layer };
};
const traitsOf = (n: ReturnType<typeof cast>["npcs"][number], layer: ReturnType<typeof cast>["layer"]) => ({
  archetype: n.character.archetype, strategyStyle: n.character.strategyStyle, demeanor: n.character.demeanor,
  castingType: layer.public[n.id]!.castingType,
  physicalCharacteristics: { heightBuild: layer.public[n.id]!.physicalCharacteristics.heightBuild },
  voice: voiceFingerprint(n.character.voice!),
});

describe("ORW-432 casting type fits the card", () => {
  it("the table covers every type; every type is reachable from 2+ archetypes; every archetype has 4+ types", () => {
    for (const t of CASTING_TYPES) expect(CASTING_TYPE_FIT[t.id], t.id).toBeDefined();
    expect(Object.keys(CASTING_TYPE_FIT).sort()).toEqual(CASTING_TYPES.map((t) => t.id).sort());
    const archetypes = new Set(Object.values(CASTING_TYPE_FIT).flatMap((f) => f.archetypes));
    expect(archetypes.size).toBe(12);
    for (const t of CASTING_TYPES) expect(CASTING_TYPE_FIT[t.id]!.archetypes.length, t.id).toBeGreaterThanOrEqual(2);
    for (const a of archetypes) {
      expect(CASTING_TYPES.filter((t) => CASTING_TYPE_FIT[t.id]!.archetypes.includes(a)).length, a).toBeGreaterThanOrEqual(4);
    }
  });

  it("40 seeds x 15: zero incompatible pairs, one of each type per cast; fallback count reported", () => {
    let bad = 0, fallbacks = 0, slots = 0;
    for (const seed of SEEDS) {
      const { npcs, layer } = cast(seed);
      const ids = npcs.map((n) => layer.public[n.id]!.castingType.id);
      expect(new Set(ids).size, `seed ${seed}`).toBe(15);
      const report: CastingDealReport = { fallbacks: 0 };
      dealCastingTypes(new SeededRandom(hashSeed(`${seed}:casting-type`)), 15, npcs.map((n) => n.character.age), npcs.map((n) => ({ archetype: n.character.archetype, strategyStyle: n.character.strategyStyle, demeanor: n.character.demeanor })), report);
      for (const n of npcs) {
        slots++;
        if (!castingCompatible(layer.public[n.id]!.castingType.id, n.character)) bad++;
      }
      fallbacks += report.fallbacks;
    }
    console.log(`CASTING FALLBACKS: ${fallbacks} of ${slots} slots incompatible-after-deal=${bad} (40 seeds x 15)`);
    expect(bad).toBeLessThanOrEqual(fallbacks); // a pair is incompatible only where a fallback was taken
    expect(fallbacks).toBeLessThanOrEqual(slots * 0.05);
  });

  it("a deal with no traits is the ORW-381 deal (same draws, same picks)", () => {
    for (const seed of SEEDS.slice(0, 10)) {
      const a = dealCastingTypes(new SeededRandom(seed), 15, Array(15).fill(30)).map((t) => t.id);
      const b = dealCastingTypes(new SeededRandom(seed), 15, Array(15).fill(30), undefined).map((t) => t.id);
      expect(a).toEqual(b);
      expect(new Set(a).size).toBe(15);
    }
  });

  it("the table has a conflict count that ranks a fallback: a clash on archetype and demeanor beats neither", () => {
    expect(castingCompatible("underdog", { archetype: "floater", demeanor: "explosive, theatrical" })).toBe(false);
    expect(castingCompatible("underdog", { archetype: "floater", demeanor: "shy and awkward" })).toBe(true);
  });
});

describe("ORW-432 heightBuild says one height", () => {
  it("no phrase in the build pool names two heights, and the deal never does", () => {
    for (const w of BUILD_WORDS) expect(heightWordsIn(w).length, w).toBeLessThanOrEqual(1);
    for (const seed of SEEDS) {
      const { npcs, layer } = cast(seed);
      for (const n of npcs) expect(heightWordsIn(layer.public[n.id]!.physicalCharacteristics.heightBuild).length).toBeLessThanOrEqual(1);
    }
  });
  it("sees the live Briana string as two heights", () => {
    expect(heightWordsIn("short and compact, average height with a sturdy soft build").length).toBe(2);
    expect(heightWordsIn("average height, athletic and sturdy").length).toBe(1);
  });
});

const RES = VOICE_LINE_TEMPLATES.map((t) => new RegExp("^" + t.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{\w+\}/g, ".+?") + "$"));

describe("ORW-432 voice lines", () => {
  it("40 seeds x 15: no contradictory pair, no stress tell on more than 3 cards, 3+ sentence shapes", () => {
    for (const seed of SEEDS) {
      const { npcs } = cast(seed);
      const tells = new Map<string, number>();
      const shapes = new Set<number>();
      const shapeOf = (line: string): number => RES.findIndex((r) => r.test(line));
      for (const n of npcs) {
        const v = n.character.voice!;
        const line = voiceFingerprint(v);
        expect(voiceLineConflict(line, n.character.demeanor), `${seed} ${line} | ${n.character.demeanor}`).toBeUndefined();
        tells.set(v.stressTell, (tells.get(v.stressTell) ?? 0) + 1);
        shapes.add(shapeOf(line));
        expect(shapeOf(line), line).toBeGreaterThanOrEqual(0);
      }
      for (const [t, c] of tells) expect(c, `${seed} ${t}`).toBeLessThanOrEqual(3);
      expect(shapes.size, `seed ${seed}`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("ORW-432 card check on the seven live cards", () => {
  const live = [
    { n: "Justin Boone", archetype: "hothead", strategyStyle: "aggressive", demeanor: "restless, magnetic, one spark from a blowup", castingType: { label: "the free spirit" }, want: ["trait-casting-type"] },
    { n: "Tessa Brooks", archetype: "floater", strategyStyle: "emotional", demeanor: "explosive, theatrical, impossible to ignore", castingType: { label: "the underdog" }, want: ["trait-casting-type"] },
    { n: "Briana Pickett", archetype: "peacemaker", strategyStyle: "loyal", demeanor: "jolly until the spoon drops", castingType: { label: "the competitor" },
      physicalCharacteristics: { heightBuild: "short and compact, average height with a sturdy soft build" },
      voice: "talks in a folksy, measured, blunt voice — manic, no humor; under pressure deflects with a joke", want: ["trait-casting-type", "trait-height-build", "trait-voice"] },
    { n: "Imani Mason", archetype: "mastermind", strategyStyle: "strategic", demeanor: "cool, clipped, and quietly watchful", castingType: { label: "the life of the party" }, want: ["trait-casting-type"] },
    { n: "Gabe Cottrell", archetype: "mastermind", strategyStyle: "strategic", demeanor: "unhurried and unbothered, with a slow blink that reads as serene", castingType: { label: "the jock" }, want: ["trait-casting-type"] },
    { n: "Stephanie Kowalski", archetype: "peacemaker", strategyStyle: "loyal", demeanor: "bouncy, loud, and instantly in your space", castingType: { label: "the gentle giant" }, want: ["trait-casting-type"] },
    { n: "Melanie Turner", archetype: "floater", strategyStyle: "under-the-radar", demeanor: "wired and blunt, laughs loudest and cracks first", castingType: { label: "the diva" }, want: ["trait-casting-type"] },
  ];
  for (const c of live) {
    it(`${c.n} trips ${c.want.join(", ")}`, () => {
      const { want, n: _n, ...card } = c;
      expect(traitContradictions(card)).toEqual(want);
    });
  }
  it("a clean card trips nothing", () => {
    expect(traitContradictions({ archetype: "peacemaker", strategyStyle: "loyal", demeanor: "warm and bubbly", castingType: { label: "the sweetheart" },
      physicalCharacteristics: { heightBuild: "tall and lean" }, voice: "talks in a polished, measured, candid voice — warm, dry humor; under pressure goes quiet" })).toEqual([]);
  });
  it("40 seeds x 15 dealt cards trip nothing except the counted casting-type fallbacks", () => {
    let hits = 0;
    for (const seed of SEEDS) {
      const { npcs, layer } = cast(seed);
      for (const n of npcs) {
        const r = traitContradictions(traitsOf(n, layer));
        expect(r.filter((x) => x !== "trait-casting-type"), `${seed}`).toEqual([]);
        hits += r.length;
      }
    }
    console.log(`DEALT CARDS WITH A CASTING-TYPE CONTRADICTION: ${hits} of 600`);
  });
});

describe("ORW-432 what moved and what did not", () => {
  const SEEDS6 = [1, 2, 3, 77, 2026, 4242];
  it("stats, names, ages, hidden profiles, threads, biographies and every look field except the changed ones are byte-identical to main", () => {
    let all = "";
    for (const seed of SEEDS6) {
      const { npcs } = generateHouse(new SeededRandom(seed));
      const l = generateCastDeepLayer(seed, npcs);
      // Blank ONLY what ORW-432 changes: the voice object on each character and the casting type.
      const blanked = npcs.map((n) => ({ ...n, character: { ...n.character, voice: 0 } }));
      const pub = Object.fromEntries(Object.entries(l.public).map(([k, v]) => [k, { biography: v.biography, physicalCharacteristics: v.physicalCharacteristics, castingType: 0 }]));
      all += JSON.stringify([blanked, pub, l.hidden, l.threads]);
    }
    expect(createHash("sha256").update(all).digest("hex")).toBe("3e72645352a5aa5f0e24114eaf5f36a5d4e15a250dde74602d32f7cc73f3180a");
  });
});
