import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { hashSeed } from "../../src/engine/characterFactory";
import { generateHouse } from "../../src/engine/characterFactory";
import { generateCastDeepLayer, BUILD_WORDS } from "../../src/engine/deepProfile";
import { voiceFingerprint, generateVoice, VOICE_DIALS, type VoiceProfile } from "../../src/engine/voice";
import { CASTING_TYPES, dealCastingTypes, recohereCastingTypes, type CastingDealReport } from "../../src/domain/castingTypes";
import {
  CASTING_TYPE_FIT, castingCompatible, castingConflict, heightWordsIn, traitContradictions, voiceLineConflict, VOICE_LINE_TEMPLATES, repairHeightBuild,
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
    expect(bad).toBe(0);
    expect(fallbacks).toBe(0);
  });

  it("a deal with no traits is the ORW-381 deal (same draws, same picks)", () => {
    for (const seed of SEEDS.slice(0, 10)) {
      const a = dealCastingTypes(new SeededRandom(seed), 15, Array(15).fill(30)).map((t) => t.id);
      const b = dealCastingTypes(new SeededRandom(seed), 15, Array(15).fill(30), undefined).map((t) => t.id);
      expect(a).toEqual(b);
      expect(new Set(a).size).toBe(15);
    }
  });

  it("omitted and empty traits give the ORW-381 deal byte for byte", () => {
    for (const seed of SEEDS) {
      const ages = Array.from({ length: 15 }, (_, i) => 20 + i * 3);
      const ids = (t?: never[]) => dealCastingTypes(new SeededRandom(seed), 15, ages, t).map((x) => x.id);
      expect(ids([])).toEqual(ids());
    }
  });

  it("an unknown or inherited-key label is unknown, never a crash", () => {
    for (const label of ["constructor", "toString", "__proto__", "hasOwnProperty", "the constructor"]) {
      expect(castingConflict(label, { archetype: "floater" }), label).toBe(0);
      expect(() => traitContradictions({ castingType: { label }, archetype: "floater" }), label).not.toThrow();
      expect(traitContradictions({ castingType: { label }, archetype: "floater" }), label).toEqual([]);
    }
  });

  it("the table has a conflict count that ranks a fallback: a clash on archetype and demeanor beats neither", () => {
    expect(castingCompatible("underdog", { archetype: "floater", demeanor: "explosive, theatrical" })).toBe(false);
    expect(castingCompatible("underdog", { archetype: "floater", demeanor: "shy and awkward" })).toBe(true);
  });
});

describe("ORW-432 a loud demeanor never gets a flat voice", () => {
  it("the rule fires on a card and the dealer never produces it", () => {
    const line = "talks in a plainspoken, measured, candid voice — flat, dry humor; under pressure goes quiet";
    expect(voiceLineConflict(line, "loud, bubbly and theatrical")).toBe("loud+flat");
    expect(voiceLineConflict(line, "quiet and watchful")).toBeUndefined();
    expect(voiceLineConflict(line, "loud and quiet by turns")).toBeUndefined(); // ambiguous: neither rule applies
    for (let i = 0; i < 300; i++) {
      const v = generateVoice(new SeededRandom(i), "villain", { fixRng: new SeededRandom(i + 1), tellCounts: new Map(), demeanor: "loud and confrontational" });
      expect(v.energy, `${i}`).not.toBe("flat");
    }
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
  it("repairs two heights to the first one plus the build phrase", () => {
    expect(repairHeightBuild("short and compact, average height with a sturdy soft build")).toBe("short and compact, with a sturdy soft build");
    expect(heightWordsIn(repairHeightBuild("tall and petite, athletic")).length).toBe(1);
    expect(repairHeightBuild("tall and lean")).toBe("tall and lean");
  });
  it("sees the live Briana string as two heights", () => {
    expect(heightWordsIn("short and compact, average height with a sturdy soft build").length).toBe(2);
    expect(heightWordsIn("average height, athletic and sturdy").length).toBe(1);
  });
});

const RES = VOICE_LINE_TEMPLATES.map((t) => new RegExp("^" + t.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{(?:a:)?\w+\}/g, ".+?") + "$"));

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

describe("ORW-432 card check on seven live-shaped cards (role labels)", () => {
  const live = [
    { n: "hothead, free spirit", archetype: "hothead", strategyStyle: "aggressive", demeanor: "restless, magnetic, one spark from a blowup", castingType: { label: "the free spirit" }, want: ["trait-casting-type"] },
    { n: "floater, underdog", archetype: "floater", strategyStyle: "emotional", demeanor: "explosive, theatrical, impossible to ignore", castingType: { label: "the underdog" }, want: ["trait-casting-type"] },
    { n: "peacemaker, competitor", archetype: "peacemaker", strategyStyle: "loyal", demeanor: "jolly until the spoon drops", castingType: { label: "the competitor" },
      physicalCharacteristics: { heightBuild: "short and compact, average height with a sturdy soft build" },
      voice: "talks in a folksy, measured, blunt voice — manic, no humor; under pressure deflects with a joke", want: ["trait-casting-type", "trait-height-build", "trait-voice"] },
    { n: "mastermind, life of the party", archetype: "mastermind", strategyStyle: "strategic", demeanor: "cool, clipped, and quietly watchful", castingType: { label: "the life of the party" }, want: ["trait-casting-type"] },
    { n: "mastermind, jock", archetype: "mastermind", strategyStyle: "strategic", demeanor: "unhurried and unbothered, with a slow blink that reads as serene", castingType: { label: "the jock" }, want: ["trait-casting-type"] },
    { n: "peacemaker, gentle giant", archetype: "peacemaker", strategyStyle: "loyal", demeanor: "bouncy, loud, and instantly in your space", castingType: { label: "the gentle giant" }, want: ["trait-casting-type"] },
    { n: "floater, diva", archetype: "floater", strategyStyle: "under-the-radar", demeanor: "wired and blunt, laughs loudest and cracks first", castingType: { label: "the diva" }, want: ["trait-casting-type"] },
  ];
  for (const c of live) {
    it(`${c.n} card trips ${c.want.join(", ")}`, () => {
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
  it("stats, names, ages, hidden profiles, threads and every look field are byte-identical to main for the blanked draws (the background text and the biographies built from it are re-pinned by ORW-458)", () => {
    // `blankText` also blanks what ORW-458 changed (the public background line and the floor biography built from it),
    // so the first hash proves NO DRAW MOVED: it equals main's hash with the same blanking. The second pins the full text.
    // NOTE (ORW-480): the blanking also covers the presentation, the mark and the face line, so a change to THOSE draws is not covered by this
    // pin; they have their own tests (castRealism.test.ts, orw480MarkRecurrence.test.ts and the style-fit parity cases).
    const run = (blankText: boolean) => {
      let all = "";
      for (const seed of SEEDS6) {
        const { npcs } = generateHouse(new SeededRandom(seed));
        const l = generateCastDeepLayer(seed, npcs);
        // Blank ONLY what ORW-432 changes: the voice object on each character and the casting type.
        // ORW-508 also blanks what its acceptance re-deal and world hometown change (vocation, hometown, the background built from the vocation, and the secrets, goals, weakness and thread premises conditioned on it); ORW-480 blanks the presentation, style line, mark and face line; ORW-508 (composed look axes) also blanks the skin tone, hair and age look (the build is blanked too, harmlessly).
        const blanked = npcs.map((n) => ({ ...n, character: { ...n.character, voice: 0, ...(blankText ? { background: 0, presentation: 0, vocation: 0, hometown: 0 } : {}) } }));
        const hid = blankText ? Object.fromEntries(Object.entries(l.hidden).map(([k, v]) => [k, { ...v, secrets: 0, trueGoals: 0, weakness: 0 }])) : l.hidden;
        const thr = blankText ? l.threads.map((t) => ({ ...t, premise: 0 })) : l.threads;
        const pub = Object.fromEntries(Object.entries(l.public).map(([k, v]) => [k, { biography: blankText ? 0 : v.biography, physicalCharacteristics: blankText ? { ...v.physicalCharacteristics, style: 0, distinguishingMark: 0, facialFeatures: 0, heightBuild: 0, skinTone: 0, hair: 0, ageLook: 0 } : v.physicalCharacteristics, castingType: 0 }]));
        all += JSON.stringify([blanked, pub, hid, thr]);
      }
      return createHash("sha256").update(all).digest("hex");
    };
    expect(run(true)).toBe("09f83e1decf4a25d50a3450376fad5f6acd5badbb0617a061ada2fdb9e428c80"); // identical on main and on the ORW-508 branch (re-taken on main with the build, skin tone, hair and age look also blanked) with ORW-508 and ORW-480 changed fields blanked: no other random draw moved
    expect(run(false)).toBe("a928d107e59832d6846e89a051799016eedcc9a9cbc8ff54945c5350a338c3c6"); // re-pinned on purpose by ORW-508 (composed look axes: build, skin tone, hair, face, style, age look and the mark pool; the blanked hash above is unchanged) and by ORW-508 earlier (hometown from the world table, a job the age rules out re-dealt, and the text built from the job) on top of ORW-458 and ORW-480 (mark pool, face lines, style family weighted by job sector, hometown and age)
  });
});

import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

describe("ORW-432 the card agrees at the END, after genesis rewrites archetype and demeanor", () => {
  const FORBID_DEMEANOR: Record<string, string> = {
    loud: "loud, explosive and theatrical", quiet: "quiet, cool and unbothered", warm: "warm, sweet and gentle", hard: "abrasive, blunt and combative",
  };
  const run = (seed: number) => {
    const s = new GameSessionAdapter();
    const warm = s.preSeedCast({ seed });
    // A stub genesis: for 5 of 15 houseguests, propose a demeanor (else an archetype) the dealt type contradicts.
    const proposals: { id: string; demeanor?: string; archetype?: string }[] = [];
    for (const c of warm.house.slice(0, 5)) {
      const fit = CASTING_TYPE_FIT[(c as unknown as { castingType?: { id: string } }).castingType?.id ?? ""];
      proposals.push({ id: c.id, demeanor: FORBID_DEMEANOR[fit?.forbidTempers[0] ?? "loud"] ?? FORBID_DEMEANOR.loud! });
    }
    expect(s.recordCastGenesis({ npcs: proposals }).accepted).toBe(true);
    s.createCharacter({ playerName: "The Player", seed });
    return s.getGameState().house.filter((h) => h.status === "active");
  };
  it("ends with zero trait-casting-type codes, one of each type, and the same types on replay", () => {
    for (const seed of [11, 987654, 2026, 4242, 31337]) {
      const a = run(seed);
      expect(a.length).toBe(15);
      for (const h of a) {
        expect(traitContradictions({ archetype: h.archetype, strategyStyle: h.strategyStyle, demeanor: h.demeanor, castingType: h.castingType }), `${seed} ${h.name} ${h.castingType?.label} | ${h.demeanor}`).not.toContain("trait-casting-type");
      }
      expect(new Set(a.map((h) => h.castingType?.label)).size).toBe(15);
      expect(run(seed).map((h) => h.castingType?.label)).toEqual(a.map((h) => h.castingType?.label));
    }
  });
});

describe("ORW-432 recohereCastingTypes", () => {
  it("is a no-op on a cast that already fits, and a function of traits and seed only", () => {
    for (const seed of SEEDS.slice(0, 10)) {
      const { npcs, layer } = cast(seed);
      const cur = npcs.map((n) => layer.public[n.id]!.castingType);
      const traits = npcs.map((n) => ({ archetype: n.character.archetype, strategyStyle: n.character.strategyStyle, demeanor: n.character.demeanor }));
      const r = recohereCastingTypes(new SeededRandom(hashSeed(`${seed}:casting-type`)), cur, npcs.map((n) => n.character.age), traits);
      expect(r.changed).toBe(0);
    }
  });
});

describe("ORW-432 the end-of-creation pass repairs authored voice and height and reports it", () => {
  it("a stub-authored contradictory voice and two-height build end with zero codes; castCoherence lists them", () => {
    const seed = 5150;
    const s = new GameSessionAdapter();
    const warm = s.preSeedCast({ seed });
    const bad: VoiceProfile = {
      register: "folksy", rhythm: "measured", energy: "manic", directness: "blunt", humor: "none",
      stressTell: "deflects with a joke", signature: "talks with their hands", lexicon: ["honestly"],
    };
    const pc = (h: string) => ({
      heightBuild: h, skinTone: "warm tan complexion", hair: "a clean side-parted dark crop", facialFeatures: "strong cheekbones",
      distinguishingMark: "none notable", ageLook: "polished, thirties poise", style: "plain tee and jeans",
    });
    const ids = warm.house.slice(0, 2).map((c) => c.id);
    const profile = { biography: "Outside the house they run a bakery they built from a single market stall over a decade of dawn shifts.", secrets: ["carries a quiet debt"], trueGoals: ["reach the end quietly"], weakness: "loyal to a fault" };
    const r1 = s.recordCastProfile({ houseguestId: ids[0]!, ...profile, voice: bad, physicalCharacteristics: pc("short and compact, average height with a sturdy soft build") });
    expect(r1.accepted).toBe(true);
    s.recordCastProfile({ houseguestId: ids[1]!, ...profile, physicalCharacteristics: pc("tall and slender, petite frame") });
    const view = s.createCharacter({ playerName: "The Player", seed });
    for (const h of view.house.filter((x) => x.status === "active")) {
      expect(traitContradictions({ archetype: h.archetype, strategyStyle: h.strategyStyle, demeanor: h.demeanor, castingType: h.castingType, physicalCharacteristics: h.physicalCharacteristics, voice: h.voice }), h.id).toEqual([]);
    }
    const listed = Object.fromEntries((view.castCoherence?.houseguests ?? []).map((x) => [x.id, x.fields]));
    expect(listed[ids[0]!]).toEqual(expect.arrayContaining(["physicalCharacteristics.heightBuild"]));
    expect(listed[ids[0]!]!.some((f) => f.startsWith("voice."))).toBe(true);
    expect(listed[ids[1]!]).toEqual(expect.arrayContaining(["physicalCharacteristics.heightBuild"]));
    expect(JSON.stringify(view.castCoherence)).not.toMatch(/folksy|deflects|measured/); // ids and field names only
  });
});

describe("ORW-432 voice line shape is the hash-selected template", () => {
  it("every template index is selected for some profile, and the line is exactly that template", () => {
    const idx = (v: VoiceProfile): number => {
      let h = 0;
      for (const ch of `${v.register}|${v.rhythm}|${v.energy}|${v.directness}|${v.humor}|${v.stressTell}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      return h % VOICE_LINE_TEMPLATES.length;
    };
    const seen = new Set<number>();
    for (let i = 0; i < 400 && seen.size < VOICE_LINE_TEMPLATES.length; i++) {
      const r = new SeededRandom(i);
      const v = generateVoice(r, "floater");
      const k = idx(v);
      const slot = (key: string): string => (key === "humor" ? (v.humor === "none" ? "no" : v.humor) : String(v[key as keyof VoiceProfile]));
      expect(voiceFingerprint(v)).toBe(VOICE_LINE_TEMPLATES[k]!.replace(/\{(a:)?(\w+)\}/g, (_m, art: string | undefined, key: string) => (art ? `${/^[aeiou]/i.test(slot(key)) ? "an" : "a"} ${slot(key)}` : slot(key))));
      seen.add(k);
    }
    expect(seen.size).toBe(VOICE_LINE_TEMPLATES.length);
    void VOICE_DIALS;
  });
});
