import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { generateHouse } from "../../src/engine/characterFactory";
import { generateCastDeepLayer } from "../../src/engine/deepProfile";
import { buildCastPortraitPrompts } from "../../src/engine/portraitPrompts";
import {
  dealShotCards, dealFaceCards, shotCaps, capOf, bucketOf, propFor, FACE_MIN_DISTANCE, MOMENTS, PLACES, LIGHTS, type ShotSheet,
} from "../../src/engine/shotCards";

// ORW-480: the shot card and the face card, dealt across the cast on their own seeded stream.

const SEEDS = Array.from({ length: 40 }, (_, i) => 11 + i * 211);
const sheetsOf = (seed: number): ShotSheet[] => {
  const { npcs } = generateHouse(new SeededRandom(seed));
  return npcs.map((n) => ({
    id: n.id, name: n.name, age: n.character.age,
    ...(n.character.demeanor ? { demeanor: n.character.demeanor } : {}),
    ...(n.character.castingType ? { castingRead: n.character.castingType.read, castingLabel: n.character.castingType.label } : {}),
    ...(n.character.voice ? { energy: n.character.voice.energy } : {}),
    ...(n.character.vocation ? { vocation: n.character.vocation } : {}),
  }));
};
const tally = (xs: string[]): number => Math.max(0, ...[...new Set(xs)].map((x) => xs.filter((y) => y === x).length));

describe("ORW-480 the caps come from the shared casting-director table", () => {
  it("a cast of 15: place 3, framing 5, light 4, prop 2, face value 3", () => {
    expect(shotCaps(15)).toMatchObject({ place: 3, framing: 5, light: 4, prop: 2, faceValue: 3 });
    expect(capOf("prop", 15)).toBe(2);
  });
});

describe("ORW-480 shot cards", () => {
  it("over 40 casts of 15: no place on more than 3, no framing on more than 5, no light on more than 4, a prop on at most 2, eyes on the lens not on everyone", () => {
    const caps = shotCaps(15);
    for (const seed of SEEDS) {
      const sheets = sheetsOf(seed);
      expect(sheets.length).toBe(15);
      const cards = [...dealShotCards(sheets).values()];
      expect(tally(cards.map((c) => c.placeId)), `place ${seed}`).toBeLessThanOrEqual(caps.place);
      expect(tally(cards.map((c) => c.framingId)), `framing ${seed}`).toBeLessThanOrEqual(caps.framing);
      expect(tally(cards.map((c) => c.lightId)), `light ${seed}`).toBeLessThanOrEqual(caps.light);
      expect(cards.filter((c) => c.prop !== undefined).length, `prop ${seed}`).toBeLessThanOrEqual(caps.prop);
      expect(cards.filter((c) => c.gaze === "lens").length, `gaze ${seed}`).toBeLessThanOrEqual(caps.lensGaze);
      expect(new Set(cards.map((c) => c.momentId)).size, `moments ${seed}`).toBe(15);
      expect(cards.filter((c) => c.outdoor).length, `outdoors ${seed}`).toBeGreaterThanOrEqual(4);
      expect(new Set(cards.map((c) => c.placeId)).size, `places ${seed}`).toBeGreaterThanOrEqual(6);
    }
  });

  it("the light fits the place and a seated shot has somewhere to sit; no moment asks for what the place lacks", () => {
    for (const seed of SEEDS) {
      for (const c of dealShotCards(sheetsOf(seed)).values()) {
        const place = PLACES.find((p) => p.id === c.placeId)!;
        const light = LIGHTS.find((l) => l.id === c.lightId)!;
        expect(light.where === "any" || (light.where === "out") === place.outdoor).toBe(true);
        if (c.framingId === "seated") expect(place.seat).toBeDefined();
        expect(c.moment).not.toMatch(/\{|undefined/);
        expect(c.moment).not.toMatch(/\bon\s*,|\bon\s*$/);
      }
    }
  });

  it("is deterministic, and the same cast in another order gets the same cards", () => {
    const sheets = sheetsOf(77);
    expect([...dealShotCards(sheets)]).toEqual([...dealShotCards(sheets)]);
    const a = dealShotCards(sheets), b = dealShotCards([...sheets].reverse());
    for (const s of sheets) expect(b.get(s.id)).toEqual(a.get(s.id));
  });

  it("the moment comes from the sheet: a watchful read gets a watchful moment, a life of the party an expressive one", () => {
    const rnd = () => 0.5;
    expect(bucketOf({ id: "a", age: 30, castingLabel: "the rebel", castingRead: "cool stare, shoulders loose, unbothered", demeanor: "guarded and wary" }, rnd)).toBe("watchful");
    expect(bucketOf({ id: "b", age: 30, castingLabel: "the life of the party", castingRead: "big laugh, animated hands, lit up", energy: "loud and warm" }, rnd)).toBe("expressive");
    expect(bucketOf({ id: "c", age: 30, castingLabel: "the competitor", castingRead: "focused eyes, set jaw, ready stance" }, rnd)).toBe("driven");
    expect(bucketOf({ id: "d", age: 30, castingLabel: "the dreamer", castingRead: "soft gaze drifting past the lens" }, rnd)).toBe("easy");
    const cards = dealShotCards([
      { id: "x1", name: "A", age: 30, castingLabel: "the life of the party", castingRead: "big laugh, animated hands, lit up" },
      { id: "x2", name: "B", age: 30, castingLabel: "the quiet storm", castingRead: "still, watchful, a small private smile" },
    ]);
    expect(MOMENTS.find((m) => m.id === cards.get("x1")!.momentId)!.bucket).toBe("expressive");
    expect(MOMENTS.find((m) => m.id === cards.get("x2")!.momentId)!.bucket).toBe("watchful");
  });

  it("a prop only when the sheet gives a reason", () => {
    expect(propFor({ id: "a", age: 30, vocation: "line cook" })).toMatch(/dish towel/);
    expect(propFor({ id: "a", age: 30, vocation: "hospice night nurse" })).toBeUndefined();
    expect(propFor({ id: "a", age: 30, vocation: "office manager" })).toBeUndefined();
    const none = dealShotCards(Array.from({ length: 15 }, (_, i) => ({ id: `n${i}`, name: `N${i}`, age: 30, vocation: "office manager" })));
    expect([...none.values()].filter((c) => c.prop).length).toBe(0);
    const many = dealShotCards(Array.from({ length: 15 }, (_, i) => ({ id: `n${i}`, name: `N${i}`, age: 30, vocation: "line cook" })));
    expect([...many.values()].filter((c) => c.prop).length).toBe(2);
    expect([...many.values()].some((c) => /\bmug\b/.test(c.prop ?? ""))).toBe(false);
  });
});

describe("ORW-480 face cards", () => {
  it("over 40 casts: no two faces share a combination (they differ on at least 4 of 7), no value on more than 3, no quirk twice", () => {
    for (const seed of SEEDS) {
      const faces = [...dealFaceCards(sheetsOf(seed)).values()];
      const axes = ["shape", "nose", "eyes", "brows", "jaw", "mouth", "quirk"] as const;
      for (let i = 0; i < faces.length; i++) for (let j = 0; j < i; j++) {
        expect(axes.filter((a) => faces[i]![a] !== faces[j]![a]).length, `seed ${seed} ${i}/${j}`).toBeGreaterThanOrEqual(FACE_MIN_DISTANCE);
      }
      for (const a of axes.filter((x) => x !== "quirk")) expect(tally(faces.map((f) => f[a])), `${a} ${seed}`).toBeLessThanOrEqual(3);
      expect(new Set(faces.map((f) => f.quirk)).size, `quirk ${seed}`).toBe(15);
    }
  });

  it("a feature the written face line names is kept (square jaw, deep-set eyes), and the rest is still dealt", () => {
    const sheets = sheetsOf(5).map((s, i) => (i < 3 ? { ...s, facialFeatures: "a square jaw and deep-set eyes" } : s));
    const faces = dealFaceCards(sheets);
    for (const s of sheets.slice(0, 3)) { expect(faces.get(s.id)!.jaw).toBe("a square jaw"); expect(faces.get(s.id)!.eyes).toBe("deep-set eyes"); }
    const three = sheets.slice(0, 3).map((s) => faces.get(s.id)!);
    expect(new Set(three.map((f) => `${f.shape}|${f.nose}|${f.brows}|${f.mouth}`)).size).toBe(3);
  });
});

describe("ORW-480 the prompts", () => {
  const LINES = JSON.parse(readFileSync(new URL("../fixtures/orw441_oncamera_lines.json", import.meta.url), "utf8")) as { gender: "man" | "woman" | "nonbinary"; onCamera: string }[];
  const cast = (extra: (i: number) => object) => sheetsOf(9).map((s, i) => ({
    id: s.id, name: s.name!, appearance: "card", age: s.age, presentation: "plain", genderPresentation: (["man", "woman", "nonbinary"] as const)[i % 3],
    ...(s.castingRead ? { castingType: { label: s.castingLabel!, read: s.castingRead } } : {}),
    physicalCharacteristics: { heightBuild: "average", skinTone: "fair", hair: "short hair", facialFeatures: "square jaw", distinguishingMark: "none notable",
      ageLook: "thirties", style: "plain", wardrobe: ["grey tee", "dark jeans"], ...extra(i) },
  }));
  it("the writer's on-camera line and the first name never reach the prompt; every prompt has a place, light, moment and face", () => {
    const c = cast((i) => ({ onCamera: `${i} Namea gazes into the camera in the lounge, the one who keeps score.` }));
    const ps = buildCastPortraitPrompts(c, "anchor");
    expect(ps.length).toBe(15);
    for (const p of ps) {
      expect(p.prompt).not.toMatch(/the one who keeps score|Namea/);
      for (const part of ["Setting: ", "Light: ", "The moment: ", "Face: "]) expect(p.prompt).toContain(part);
      expect(p.prompt).not.toMatch(/Waist-up|softly out of focus|85mm|soft flattering/);
    }
    expect(LINES.length).toBe(28);
  });
  it("across 15 prompts no room, light or moment sentence is shared by more than its cap", () => {
    const ps = buildCastPortraitPrompts(cast(() => ({})), "anchor").map((p) => p.prompt);
    const get = (re: RegExp): string[] => ps.map((p) => re.exec(p)![1]!);
    expect(tally(get(/Setting: ([^.]+\.)/))).toBeLessThanOrEqual(3);
    expect(tally(get(/Light: ([^.]+\.)/))).toBeLessThanOrEqual(4);
    expect(tally(get(/The moment: ([^.]+\.)/))).toBe(1);
  });
  it("the cast build and a one-person ask agree (same deal, same text)", () => {
    const c = cast(() => ({}));
    const a = buildCastPortraitPrompts(c, "x"), b = buildCastPortraitPrompts(c, "y");
    expect(a).toEqual(b);
  });
});

describe("ORW-480 no other dealt value moves", () => {
  it("the cast (names, ages, stats), hidden profiles and threads hash is the one creationLooks381 pins, with the shot and face deals run in between", () => {
    const run = (blankText: boolean) => {
      let all = "";
      for (const seed of [1, 2, 3, 77, 2026, 4242]) {
        const { npcs } = generateHouse(new SeededRandom(seed));
        dealShotCards(sheetsOf(seed)); dealFaceCards(sheetsOf(seed)); // our own stream: draws nothing from the game's
        const l = generateCastDeepLayer(seed, npcs);
        dealShotCards(sheetsOf(seed));
        const pub = Object.fromEntries(Object.entries(l.public).map(([k, v]) => [k, { biography: blankText ? 0 : v.biography, physicalCharacteristics: 0 }]));
        const cast = blankText ? npcs.map((n) => ({ ...n, character: { ...n.character, background: 0 } })) : npcs;
        all += JSON.stringify([cast, pub, l.hidden, l.threads]);
      }
      return createHash("sha256").update(all).digest("hex");
    };
    expect(run(true)).toBe("2d2b169fab03fcb30110d4031c4f9f544809700b1c3ca4b05c1b5c0bc85b5eec");
    expect(run(false)).toBe("47784456afb1c29f278da1f706f55715ca95bd7d3984cc330aecffad4d846b2b");
  });
});
